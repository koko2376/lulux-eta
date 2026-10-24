import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  BUILTIN_AGENT_ID,
  DEFAULT_AGENT_ID,
  LEGACY_AGENT_IDS,
  RETIRED_PERSONA_IDS,
} from "../agents.js";
import { companyNorm } from "../utils/customer-keys.js";

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

function columnsOf(db: DatabaseSync, table: string): string[] {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function addColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  ddl: string,
): void {
  if (!columnsOf(db, table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table) as unknown as { ok: number } | undefined;
  return Boolean(row);
}

/**
 * 有序迁移。已发布的迁移不可修改，只能追加。
 * 001 兼容所有旧库：建表用 IF NOT EXISTS，缺失的列补齐。
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "baseline",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS providers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          base_url TEXT NOT NULL,
          api_key TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL,
          models TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          provider_id TEXT,
          group_name TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
        CREATE TABLE IF NOT EXISTS session_members (
          session_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (session_id, agent_id),
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_session_members ON session_members(session_id, position);
        CREATE TABLE IF NOT EXISTS mcp_servers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          command TEXT NOT NULL,
          args TEXT NOT NULL DEFAULT '[]',
          env TEXT NOT NULL DEFAULT '{}',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      addColumn(db, "messages", "sender_agent_id", "TEXT");
      addColumn(db, "messages", "tool_trace", "TEXT");
      addColumn(db, "sessions", "group_name", "TEXT");
      addColumn(db, "providers", "models", "TEXT NOT NULL DEFAULT '[]'");
    },
  },
  {
    version: 2,
    name: "rename-agent-ids",
    up(db) {
      for (const [oldId, newId] of Object.entries(LEGACY_AGENT_IDS)) {
        // 同一会话里新旧 id 同时存在时（理论上不会），先删旧的避免主键冲突
        db.prepare(
          `DELETE FROM session_members WHERE agent_id = ? AND session_id IN (
             SELECT session_id FROM session_members WHERE agent_id = ?)`,
        ).run(oldId, newId);
        db.prepare(
          "UPDATE session_members SET agent_id = ? WHERE agent_id = ?",
        ).run(newId, oldId);
        db.prepare(
          "UPDATE messages SET sender_agent_id = ? WHERE sender_agent_id = ?",
        ).run(newId, oldId);
        db.prepare(
          "UPDATE settings SET value = ? WHERE key = 'defaultAgentId' AND value = ?",
        ).run(newId, oldId);
      }
      db.prepare(
        `INSERT OR IGNORE INTO session_members (session_id, agent_id, position)
         SELECT s.id, ?, 0 FROM sessions s
         WHERE NOT EXISTS (SELECT 1 FROM session_members m WHERE m.session_id = s.id)`,
      ).run(DEFAULT_AGENT_ID);
    },
  },
  {
    version: 3,
    name: "message-runtime-and-tool-rounds",
    up(db) {
      // runtime：实际运行者（provider / kernel）；tool_rounds：工具调用与结果，供下一轮上下文使用
      addColumn(db, "messages", "runtime", "TEXT");
      addColumn(db, "messages", "tool_rounds", "TEXT");
    },
  },
  {
    version: 4,
    name: "mcp-approval",
    up(db) {
      // 命令确认指纹；旧记录为 NULL，需要重新确认后才会启动
      addColumn(db, "mcp_servers", "approved_hash", "TEXT");
    },
  },
  {
    version: 5,
    name: "business-tables",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS customers (
          id TEXT PRIMARY KEY,
          company TEXT NOT NULL,
          company_key TEXT NOT NULL DEFAULT '',
          country TEXT NOT NULL DEFAULT '',
          website TEXT NOT NULL DEFAULT '',
          website_key TEXT NOT NULL DEFAULT '',
          stage TEXT NOT NULL DEFAULT 'lead',
          tags TEXT NOT NULL DEFAULT '[]',
          source TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_customers_updated ON customers(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_customers_company_key ON customers(company_key);
        CREATE INDEX IF NOT EXISTS idx_customers_website_key ON customers(website_key);
        CREATE TABLE IF NOT EXISTS contacts (
          id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          email TEXT NOT NULL DEFAULT '',
          phone TEXT NOT NULL DEFAULT '',
          whatsapp TEXT NOT NULL DEFAULT '',
          is_primary INTEGER NOT NULL DEFAULT 0,
          position INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_contacts_customer ON contacts(customer_id, position);
        CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
        CREATE TABLE IF NOT EXISTS activities (
          id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_activities_customer ON activities(customer_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_activities_created ON activities(created_at DESC);
        CREATE TABLE IF NOT EXISTS products (
          id TEXT PRIMARY KEY,
          sku TEXT NOT NULL DEFAULT '',
          name TEXT NOT NULL,
          spec TEXT NOT NULL DEFAULT '',
          unit TEXT NOT NULL DEFAULT '',
          price REAL NOT NULL DEFAULT 0,
          currency TEXT NOT NULL DEFAULT 'USD',
          moq INTEGER NOT NULL DEFAULT 0,
          hs_code TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS quotes (
          id TEXT PRIMARY KEY,
          number TEXT NOT NULL UNIQUE,
          customer_id TEXT NOT NULL,
          currency TEXT NOT NULL,
          incoterm TEXT NOT NULL,
          port TEXT NOT NULL DEFAULT '',
          valid_until TEXT NOT NULL DEFAULT '',
          payment_terms TEXT NOT NULL DEFAULT '',
          lead_time TEXT NOT NULL DEFAULT '',
          items TEXT NOT NULL DEFAULT '[]',
          notes TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft',
          subtotal REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_quotes_customer ON quotes(customer_id);
        CREATE TABLE IF NOT EXISTS inquiry_rules (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          conditions TEXT NOT NULL DEFAULT '[]',
          action TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS quote_templates (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0,
          company TEXT NOT NULL DEFAULT '{}',
          default_incoterm TEXT NOT NULL DEFAULT 'FOB',
          default_currency TEXT NOT NULL DEFAULT 'USD',
          default_payment_terms TEXT NOT NULL DEFAULT '',
          footer TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 6,
    name: "teams-users-ownership-audit",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS orgs (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL,
          email TEXT NOT NULL COLLATE NOCASE UNIQUE,
          name TEXT NOT NULL,
          role TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          disabled INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_login_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS teams (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS team_members (
          team_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          PRIMARY KEY (team_id, user_id),
          FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS auth_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          absolute_expires_at INTEGER NOT NULL,
          ip TEXT NOT NULL DEFAULT '',
          user_agent TEXT NOT NULL DEFAULT '',
          revoked_at INTEGER,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
        CREATE TABLE IF NOT EXISTS invites (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL,
          code_hash TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL,
          email TEXT,
          team_id TEXT,
          max_uses INTEGER NOT NULL DEFAULT 1,
          uses INTEGER NOT NULL DEFAULT 0,
          expires_at INTEGER NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL,
          at INTEGER NOT NULL,
          user_id TEXT,
          user_name TEXT NOT NULL DEFAULT '',
          action TEXT NOT NULL,
          entity_type TEXT,
          entity_id TEXT,
          summary TEXT NOT NULL DEFAULT '',
          ip TEXT NOT NULL DEFAULT '',
          meta TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(org_id, at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
      `);
      for (const table of ["customers", "sessions"]) {
        addColumn(db, table, "org_id", "TEXT NOT NULL DEFAULT 'local'");
        addColumn(db, table, "owner_id", "TEXT NOT NULL DEFAULT 'local'");
        addColumn(db, table, "visibility", "TEXT NOT NULL DEFAULT 'private'");
        addColumn(db, table, "team_id", "TEXT");
      }
      addColumn(db, "quotes", "org_id", "TEXT NOT NULL DEFAULT 'local'");
      addColumn(db, "quotes", "owner_id", "TEXT NOT NULL DEFAULT 'local'");
      addColumn(db, "activities", "actor_id", "TEXT");
      addColumn(db, "activities", "actor_name", "TEXT");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_customers_owner ON customers(org_id, owner_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(org_id, owner_id);
        CREATE INDEX IF NOT EXISTS idx_quotes_owner ON quotes(org_id, owner_id);
      `);
    },
  },
  {
    version: 7,
    name: "email",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS email_accounts (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL DEFAULT 'local',
          owner_id TEXT NOT NULL DEFAULT 'local',
          visibility TEXT NOT NULL DEFAULT 'private',
          team_id TEXT,
          name TEXT NOT NULL DEFAULT '',
          email TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          preset_id TEXT,
          auth_type TEXT NOT NULL DEFAULT 'password',
          oauth_provider TEXT,
          imap_host TEXT NOT NULL,
          imap_port INTEGER NOT NULL,
          imap_secure INTEGER NOT NULL DEFAULT 1,
          imap_user TEXT NOT NULL,
          smtp_host TEXT NOT NULL,
          smtp_port INTEGER NOT NULL,
          smtp_secure INTEGER NOT NULL DEFAULT 1,
          smtp_user TEXT NOT NULL,
          secret TEXT NOT NULL DEFAULT '',
          oauth_access TEXT NOT NULL DEFAULT '',
          oauth_expires_at INTEGER,
          sync_enabled INTEGER NOT NULL DEFAULT 1,
          sync_days INTEGER NOT NULL DEFAULT 30,
          append_to_sent INTEGER NOT NULL DEFAULT 1,
          signature TEXT NOT NULL DEFAULT '',
          inbox_path TEXT NOT NULL DEFAULT 'INBOX',
          sent_path TEXT,
          state TEXT NOT NULL DEFAULT 'idle',
          last_sync_at INTEGER,
          last_error TEXT,
          last_error_code TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_email_accounts_owner ON email_accounts(org_id, owner_id);
        CREATE TABLE IF NOT EXISTS email_sync_state (
          account_id TEXT NOT NULL,
          role TEXT NOT NULL,
          folder_path TEXT NOT NULL,
          uid_validity TEXT NOT NULL DEFAULT '',
          last_uid INTEGER NOT NULL DEFAULT 0,
          highest_modseq TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (account_id, role),
          FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS email_messages (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          folder TEXT NOT NULL,
          folder_path TEXT NOT NULL DEFAULT '',
          uid INTEGER,
          uid_validity TEXT NOT NULL DEFAULT '',
          message_id TEXT NOT NULL DEFAULT '',
          thread_key TEXT NOT NULL DEFAULT '',
          in_reply_to TEXT,
          refs TEXT NOT NULL DEFAULT '[]',
          from_name TEXT NOT NULL DEFAULT '',
          from_address TEXT NOT NULL DEFAULT '',
          to_json TEXT NOT NULL DEFAULT '[]',
          cc_json TEXT NOT NULL DEFAULT '[]',
          reply_to_json TEXT NOT NULL DEFAULT '[]',
          subject TEXT NOT NULL DEFAULT '',
          date INTEGER NOT NULL,
          snippet TEXT NOT NULL DEFAULT '',
          text_body TEXT NOT NULL DEFAULT '',
          html_body TEXT,
          truncated INTEGER NOT NULL DEFAULT 0,
          seen INTEGER NOT NULL DEFAULT 0,
          flagged INTEGER NOT NULL DEFAULT 0,
          has_attachments INTEGER NOT NULL DEFAULT 0,
          verdict TEXT,
          verdict_source TEXT,
          verdict_reason TEXT NOT NULL DEFAULT '',
          matched_rule_id TEXT,
          customer_id TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE,
          FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_email_messages_uid ON email_messages(account_id, folder, uid_validity, uid) WHERE uid IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_email_messages_date ON email_messages(account_id, folder, date DESC);
        CREATE INDEX IF NOT EXISTS idx_email_messages_customer ON email_messages(customer_id);
        CREATE INDEX IF NOT EXISTS idx_email_messages_msgid ON email_messages(account_id, message_id);
        CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON email_messages(thread_key);
        CREATE TABLE IF NOT EXISTS email_attachments (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL,
          part TEXT NOT NULL DEFAULT '',
          filename TEXT NOT NULL DEFAULT '',
          content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
          size INTEGER NOT NULL DEFAULT 0,
          content_id TEXT,
          inline INTEGER NOT NULL DEFAULT 0,
          local_path TEXT,
          position INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (message_id) REFERENCES email_messages(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_email_attachments_message ON email_attachments(message_id);
        CREATE TABLE IF NOT EXISTS email_drafts (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          owner_id TEXT NOT NULL DEFAULT 'local',
          reply_to_message_id TEXT,
          customer_id TEXT,
          quote_id TEXT,
          to_json TEXT NOT NULL DEFAULT '[]',
          cc_json TEXT NOT NULL DEFAULT '[]',
          bcc_json TEXT NOT NULL DEFAULT '[]',
          subject TEXT NOT NULL DEFAULT '',
          text_body TEXT NOT NULL DEFAULT '',
          attach_quote_pdf INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL DEFAULT 'user',
          ai_json TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          error TEXT,
          sent_at INTEGER,
          sent_message_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_email_drafts_account ON email_drafts(account_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS email_draft_attachments (
          id TEXT PRIMARY KEY,
          draft_id TEXT NOT NULL,
          filename TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          local_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (draft_id) REFERENCES email_drafts(id) ON DELETE CASCADE
        );
      `);
    },
  },
  {
    // 内置内核（docs/BUILTIN-KERNEL.md）：推理/usage/结束原因、会话业务上下文、用量表、上下文摘要缓存、内核配置
    version: 8,
    name: "builtin_kernel",
    up(db) {
      addColumn(db, "messages", "reasoning", "TEXT");
      addColumn(db, "messages", "usage", "TEXT");
      addColumn(db, "messages", "finish_reason", "TEXT");
      addColumn(db, "sessions", "kernel_context", "TEXT");
      db.exec(`
        CREATE TABLE IF NOT EXISTS llm_usage (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL DEFAULT 'local',
          owner_id TEXT NOT NULL DEFAULT 'local',
          session_id TEXT,
          message_id TEXT,
          agent_id TEXT,
          provider_id TEXT NOT NULL,
          provider_name TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL,
          purpose TEXT NOT NULL DEFAULT 'chat',
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          reasoning_tokens INTEGER NOT NULL DEFAULT 0,
          estimated INTEGER NOT NULL DEFAULT 0,
          cost REAL,
          currency TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_llm_usage_owner ON llm_usage(org_id, owner_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_llm_usage_session ON llm_usage(session_id);
        CREATE INDEX IF NOT EXISTS idx_llm_usage_message ON llm_usage(message_id);
        CREATE TABLE IF NOT EXISTS chat_summaries (
          session_id TEXT PRIMARY KEY,
          upto_message_id TEXT NOT NULL,
          summarized_count INTEGER NOT NULL DEFAULT 0,
          summary TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS kernel_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  },
  {
    // Skill 系统与 Agent 自配置（docs/SKILLS.md，契约第 8 节）：skill 状态/来源/用量、按 Agent 的 skill 选择、
    // MCP 远程 HTTP 传输（transport/url/headers）与创建者
    version: 9,
    name: "skills",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS skills (
          name TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          origin TEXT NOT NULL DEFAULT '',
          installed_by TEXT NOT NULL DEFAULT 'user',
          has_scripts INTEGER NOT NULL DEFAULT 0,
          content_hash TEXT NOT NULL DEFAULT '',
          builtin_hash TEXT,
          use_count INTEGER NOT NULL DEFAULT 0,
          last_used_at INTEGER,
          installed_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS skill_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          skill TEXT NOT NULL,
          kind TEXT NOT NULL,
          session_id TEXT,
          agent_id TEXT,
          owner_id TEXT NOT NULL DEFAULT 'local',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_skill_usage_skill ON skill_usage(skill, created_at);
        CREATE TABLE IF NOT EXISTS agent_skills (
          agent_id TEXT PRIMARY KEY,
          mode TEXT NOT NULL DEFAULT 'all',
          skills TEXT NOT NULL DEFAULT '[]',
          updated_at INTEGER NOT NULL
        );
      `);
      addColumn(
        db,
        "mcp_servers",
        "transport",
        "TEXT NOT NULL DEFAULT 'stdio'",
      );
      addColumn(db, "mcp_servers", "url", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "mcp_servers", "headers", "TEXT NOT NULL DEFAULT ''");
      addColumn(
        db,
        "mcp_servers",
        "created_by",
        "TEXT NOT NULL DEFAULT 'user'",
      );
    },
  },
  {
    // CRM 任务 / 跟进提醒（契约 §10.2）：按负责人 + 到期时间查询；随客户删除级联
    version: 10,
    name: "crm_tasks",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          customer_id TEXT REFERENCES customers(id) ON DELETE CASCADE,
          quote_id TEXT,
          due_at INTEGER,
          status TEXT NOT NULL DEFAULT 'open',
          priority TEXT NOT NULL DEFAULT 'normal',
          source TEXT NOT NULL DEFAULT 'user',
          org_id TEXT NOT NULL DEFAULT 'local',
          owner_id TEXT NOT NULL DEFAULT 'local',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          done_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_owner_due ON tasks(org_id, owner_id, status, due_at);
        CREATE INDEX IF NOT EXISTS idx_tasks_customer ON tasks(customer_id);
        CREATE INDEX IF NOT EXISTS idx_customers_stage ON customers(org_id, stage);
        CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(org_id, status);
      `);
    },
  },
  {
    // 任务到期提醒：记录已推送 task.due 的时间，避免重复提醒（改到期时间后清空）
    version: 11,
    name: "task_reminders",
    up(db) {
      addColumn(db, "tasks", "reminded_at", "INTEGER");
    },
  },
  {
    // 商机（Deal）+ 订单 / 出运 / 收款（契约 §10.7 / §10.8）：随客户可见、随客户删除级联
    version: 12,
    name: "crm_deals_orders",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS deals (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          quote_id TEXT,
          amount REAL NOT NULL DEFAULT 0,
          currency TEXT NOT NULL DEFAULT 'USD',
          stage TEXT NOT NULL DEFAULT 'prospecting',
          probability INTEGER,
          expected_close TEXT NOT NULL DEFAULT '',
          won_reason TEXT NOT NULL DEFAULT '',
          lost_reason TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'user',
          org_id TEXT NOT NULL DEFAULT 'local',
          owner_id TEXT NOT NULL DEFAULT 'local',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          closed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_deals_customer ON deals(customer_id);
        CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(org_id, stage);
        CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY,
          number TEXT NOT NULL UNIQUE,
          customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          quote_id TEXT UNIQUE,
          deal_id TEXT,
          currency TEXT NOT NULL DEFAULT 'USD',
          amount REAL NOT NULL DEFAULT 0,
          items TEXT NOT NULL DEFAULT '[]',
          incoterm TEXT NOT NULL DEFAULT '',
          payment_terms TEXT NOT NULL DEFAULT '',
          deposit_amount REAL NOT NULL DEFAULT 0,
          due_date TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending_production',
          notes TEXT NOT NULL DEFAULT '',
          container_type TEXT NOT NULL DEFAULT '',
          container_no TEXT NOT NULL DEFAULT '',
          bl_no TEXT NOT NULL DEFAULT '',
          vessel TEXT NOT NULL DEFAULT '',
          port_of_loading TEXT NOT NULL DEFAULT '',
          port_of_discharge TEXT NOT NULL DEFAULT '',
          etd TEXT NOT NULL DEFAULT '',
          eta TEXT NOT NULL DEFAULT '',
          org_id TEXT NOT NULL DEFAULT 'local',
          owner_id TEXT NOT NULL DEFAULT 'local',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          shipped_at INTEGER,
          completed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
        CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(org_id, status);
        CREATE TABLE IF NOT EXISTS payments (
          id TEXT PRIMARY KEY,
          order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          amount REAL NOT NULL,
          currency TEXT NOT NULL,
          received_at TEXT NOT NULL,
          method TEXT NOT NULL DEFAULT '',
          reference TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL DEFAULT 'local',
          source TEXT NOT NULL DEFAULT 'user',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
      `);
    },
  },
  {
    version: 13,
    name: "personas-to-builtin-kernel",
    up(db) {
      // 会话只选择内核：旧 persona（以及更早的 id）都并入 LULUX 内核。
      // 同一会话里多个旧 persona 合并成一个成员（保留最靠前的位置）。
      const placeholders = RETIRED_PERSONA_IDS.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT session_id, MIN(position) AS position FROM session_members
           WHERE agent_id IN (${placeholders}) GROUP BY session_id`,
        )
        .all(...RETIRED_PERSONA_IDS) as unknown as Array<{
        session_id: string;
        position: number;
      }>;
      const remove = db.prepare(
        `DELETE FROM session_members WHERE session_id = ? AND agent_id IN (${placeholders})`,
      );
      const insert = db.prepare(
        "INSERT OR IGNORE INTO session_members (session_id, agent_id, position) VALUES (?, ?, ?)",
      );
      for (const row of rows) {
        remove.run(row.session_id, ...RETIRED_PERSONA_IDS);
        insert.run(row.session_id, BUILTIN_AGENT_ID, row.position);
      }
      db.prepare(
        `UPDATE messages SET sender_agent_id = ? WHERE sender_agent_id IN (${placeholders})`,
      ).run(BUILTIN_AGENT_ID, ...RETIRED_PERSONA_IDS);
      // 按 Agent 的 skill 配置：内置内核沿用原默认 persona（lux-trade）的配置，其余旧 persona 的配置删除
      if (tableExists(db, "agent_skills")) {
        db.prepare(
          `INSERT OR IGNORE INTO agent_skills (agent_id, mode, skills, updated_at)
           SELECT ?, mode, skills, updated_at FROM agent_skills WHERE agent_id = 'lux-trade'`,
        ).run(BUILTIN_AGENT_ID);
        db.prepare(
          `DELETE FROM agent_skills WHERE agent_id IN (${placeholders})`,
        ).run(...RETIRED_PERSONA_IDS);
      }
      db.prepare(
        `UPDATE settings SET value = ? WHERE key = 'defaultAgentId' AND value IN (${placeholders})`,
      ).run(BUILTIN_AGENT_ID, ...RETIRED_PERSONA_IDS);
    },
  },
  {
    // 本机账户（desktop 模式）：用户名（不区分大小写唯一）+ scrypt 密码；会话 token 只存 sha256。
    // 编号 14：master 上 13 已被 personas_to_builtin 占用（合并时保持 14）。
    version: 14,
    name: "local_accounts",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS local_accounts (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          username_norm TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_login_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS local_sessions (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES local_accounts(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          persistent INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          absolute_expires_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_local_sessions_account ON local_sessions(account_id);
      `);
    },
  },
  {
    // 消息附件（图片输入）：只存会话工作区内的引用 JSON，base64 只在请求上游时临时内联
    // 编号 15：14 已被 local_accounts（feat-localauth）占用
    version: 15,
    name: "message_attachments",
    up(db) {
      addColumn(db, "messages", "attachments", "TEXT");
    },
  },
  {
    // 群聊主管：sessions.supervisor_id（NULL = 默认 LULUX；'none' = 无主管；否则为成员 Agent id）
    // messages.supervisor_role：主管的规划（plan）/ 汇总（summary）消息
    // 编号 16：15 被 feat-vision 的 messages.attachments 占用
    version: 16,
    name: "group_supervisor",
    up(db) {
      addColumn(db, "sessions", "supervisor_id", "TEXT");
      addColumn(db, "messages", "supervisor_role", "TEXT");
    },
  },
  {
    // 会话类型：'single'（单聊，恰好一个内核）/ 'group'（群聊）。群聊只能新建，不能由单聊转换
    // 回填：成员多于一个的旧会话视为群聊
    version: 17,
    name: "session_kind",
    up(db) {
      addColumn(db, "sessions", "kind", "TEXT NOT NULL DEFAULT 'single'");
      db.exec(`
        UPDATE sessions SET kind = 'group'
        WHERE id IN (
          SELECT session_id FROM session_members GROUP BY session_id HAVING COUNT(*) > 1
        );
      `);
    },
  },
  {
    // 工作流（多 Agent DAG）与定时任务。归属/可见性列与其它业务表一致（org_id / owner_id / visibility / team_id）。
    // sessions.workflow_run_id：工作流节点的隐藏会话（不在会话列表里出现，可从运行记录打开）。
    // 编号 18：17 被 feat-groups 的 sessions.kind 占用（合并时两者互不影响：kind 仍为 single，隐藏与否看 workflow_run_id）
    version: 18,
    name: "workflows_schedules",
    up(db) {
      addColumn(db, "sessions", "workflow_run_id", "TEXT");
      db.exec(`
        CREATE TABLE IF NOT EXISTS workflows (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          nodes TEXT NOT NULL DEFAULT '[]',
          edges TEXT NOT NULL DEFAULT '[]',
          viewport TEXT,
          org_id TEXT NOT NULL DEFAULT 'local',
          owner_id TEXT NOT NULL DEFAULT 'local',
          visibility TEXT NOT NULL DEFAULT 'private',
          team_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_workflows_owner ON workflows(org_id, owner_id, updated_at);

        CREATE TABLE IF NOT EXISTS workflow_runs (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
          trigger TEXT NOT NULL DEFAULT 'manual',
          schedule_id TEXT,
          status TEXT NOT NULL DEFAULT 'queued',
          input TEXT NOT NULL DEFAULT '',
          snapshot TEXT NOT NULL DEFAULT '{}',
          error TEXT,
          org_id TEXT NOT NULL DEFAULT 'local',
          owner_id TEXT NOT NULL DEFAULT 'local',
          started_at INTEGER NOT NULL,
          finished_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id, started_at);
        CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

        CREATE TABLE IF NOT EXISTS workflow_run_nodes (
          run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'queued',
          output TEXT NOT NULL DEFAULT '',
          error TEXT,
          session_id TEXT,
          started_at INTEGER,
          finished_at INTEGER,
          PRIMARY KEY (run_id, node_id)
        );

        CREATE TABLE IF NOT EXISTS schedules (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          target TEXT NOT NULL,
          spec TEXT NOT NULL,
          timezone TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          anchor_at INTEGER NOT NULL,
          next_run_at INTEGER,
          last_run_at INTEGER,
          last_status TEXT,
          last_error TEXT,
          org_id TEXT NOT NULL DEFAULT 'local',
          owner_id TEXT NOT NULL DEFAULT 'local',
          visibility TEXT NOT NULL DEFAULT 'private',
          team_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);
        CREATE INDEX IF NOT EXISTS idx_schedules_owner ON schedules(org_id, owner_id);

        CREATE TABLE IF NOT EXISTS schedule_runs (
          id TEXT PRIMARY KEY,
          schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'queued',
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          error TEXT,
          workflow_run_id TEXT,
          session_id TEXT,
          missed INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule ON schedule_runs(schedule_id, started_at);
      `);
    },
  },
  {
    // 账户隔离与多人群聊（契约 §5.6a / §6.10）：
    // - 会话 / 工作流 / 定时任务只属于负责人本人：去掉 team / org 共享（visibility 一律 private），admin 也看不到别人的
    // - session_participants：群聊里的真人同事（群主是 sessions.owner_id，不在表里）；role = admin（群管理员）/ member
    // - messages.sender_user_id：用户消息由谁发出（多人群聊显示发言人）；旧消息回填为会话负责人
    version: 19,
    name: "session_participants",
    up(db) {
      addColumn(db, "messages", "sender_user_id", "TEXT");
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_participants (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'member',
          added_by TEXT,
          joined_at INTEGER NOT NULL,
          PRIMARY KEY (session_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_session_participants_user ON session_participants(user_id);
        UPDATE sessions SET visibility = 'private' WHERE visibility <> 'private';
        UPDATE workflows SET visibility = 'private' WHERE visibility <> 'private';
        UPDATE schedules SET visibility = 'private' WHERE visibility <> 'private';
        UPDATE messages SET sender_user_id = (SELECT s.owner_id FROM sessions s WHERE s.id = messages.session_id)
          WHERE role = 'user' AND sender_user_id IS NULL;
      `);
    },
  },
  {
    // 会话权限级别（契约 §6.11）：sessions.permission_level（read | ask | full；NULL = 跟随全局默认）。
    // 旧的全局设置 toolApproval 升级为新会话默认级别 defaultPermissionLevel：ask → ask，auto → full。
    version: 20,
    name: "session_permission_level",
    up(db) {
      addColumn(db, "sessions", "permission_level", "TEXT");
      if (tableExists(db, "settings")) {
        db.exec(`
          INSERT INTO settings (key, value)
            SELECT 'defaultPermissionLevel', CASE value WHEN 'auto' THEN 'full' ELSE 'ask' END
            FROM settings WHERE key = 'toolApproval'
          ON CONFLICT(key) DO NOTHING;
        `);
      }
    },
  },
  {
    // 长期记忆（契约 §6.12）：每个账号自己的「用户画像」与「记忆」两个分区，条目 + 字符预算。
    // 严格按 owner_id（账号）隔离，admin / owner 也读不到别人的；本机模式为 local 账号。
    // - memory_entries：条目（section = profile | notes），记录来源（agent / user / auto / import）与来源会话
    // - memory_prefs：每个账号的开关（记忆总开关、自动提取），不放在组织级 settings 里（成员也能改自己的）
    // - memory_snapshots：会话开始时冻结的记忆快照（按会话 + 发言人），会话中途写入不改变系统提示（保住前缀缓存）
    // - memory_extractions：自动提取进度（每个会话 + 账号处理到哪条消息）
    version: 21,
    name: "user_memory",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_entries (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL DEFAULT 'local',
          owner_id TEXT NOT NULL DEFAULT 'local',
          section TEXT NOT NULL CHECK (section IN ('profile', 'notes')),
          content TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'user',
          source_session_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_entries_owner ON memory_entries(owner_id, section, created_at);

        CREATE TABLE IF NOT EXISTS memory_prefs (
          owner_id TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL DEFAULT 1,
          auto_extract INTEGER NOT NULL DEFAULT 1,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memory_snapshots (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          owner_id TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (session_id, owner_id)
        );

        CREATE TABLE IF NOT EXISTS memory_extractions (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          owner_id TEXT NOT NULL,
          last_message_at INTEGER NOT NULL DEFAULT 0,
          user_turns INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (session_id, owner_id)
        );
      `);
    },
  },
  {
    // 会话模型与推理强度（契约 §6.13）：sessions.model / sessions.reasoning_effort；NULL = 跟随默认
    // （内置内核 / scoped 内核：Provider 的默认模型 + 全局 reasoningEffort；global 内核：CLI 自己的默认）。
    // （21 号是长期记忆。）
    version: 22,
    name: "session_model_effort",
    up(db) {
      addColumn(db, "sessions", "model", "TEXT");
      addColumn(db, "sessions", "reasoning_effort", "TEXT");
    },
  },
  {
    // 记忆安全加固（增量审计 S2-1 / S3-2）：
    // - memory_prefs.group_memory：按账号的“群聊中使用我的记忆”（默认关：多人群聊不注入记忆快照）
    // - sessions.origin：会话来源 chat | schedule | workflow（持久化；定时任务 / 工作流产生的会话永不自动提取记忆）
    version: 23,
    name: "memory_hardening",
    up(db) {
      addColumn(db, "memory_prefs", "group_memory", "INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "sessions", "origin", "TEXT NOT NULL DEFAULT 'chat'");
      db.exec(
        "UPDATE sessions SET origin = 'workflow' WHERE workflow_run_id IS NOT NULL",
      );
      db.exec(
        "UPDATE sessions SET origin = 'schedule' WHERE id IN (SELECT session_id FROM schedule_runs WHERE session_id IS NOT NULL) AND title LIKE '[定时]%'",
      );
    },
  },
  {
    // 按账号的细粒度权限：在角色默认权限之上授予（grant）或收回（deny）单项业务权限（契约 5.5）
    version: 24,
    name: "user_permission_overrides",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_permission_overrides (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          permission TEXT NOT NULL,
          effect TEXT NOT NULL CHECK (effect IN ('grant', 'deny')),
          updated_by TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, permission)
        );
      `);
    },
  },
  {
    // 本机账户找回：恢复码只存哈希；早期版本建的账户没有恢复码，下次登录后提示保存一个新的
    version: 25,
    name: "local_account_recovery",
    up(db) {
      addColumn(db, "local_accounts", "recovery_hash", "TEXT");
      addColumn(db, "local_accounts", "recovery_created_at", "INTEGER");
      addColumn(
        db,
        "local_accounts",
        "recovery_prompt",
        "INTEGER NOT NULL DEFAULT 0",
      );
      db.exec(
        "UPDATE local_accounts SET recovery_prompt = 1 WHERE recovery_hash IS NULL",
      );
    },
  },
  {
    // 按模型的能力设置：providers.model_caps = {"模型名": {reasoning?: 手动思考强度, detected?: 上游元数据识别}}
    version: 26,
    name: "provider_model_caps",
    up(db) {
      addColumn(db, "providers", "model_caps", "TEXT NOT NULL DEFAULT '{}'");
    },
  },
  {
    // 成员生命周期：
    // - users.must_change_password：管理员设置 / 重置的密码，成员下次登录必须先改密；
    // - schedules.owner_paused：负责人账号停用时暂停的定时任务（不改 enabled，账号启用后自动恢复）
    version: 27,
    name: "member_lifecycle",
    up(db) {
      addColumn(
        db,
        "users",
        "must_change_password",
        "INTEGER NOT NULL DEFAULT 0",
      );
      addColumn(db, "schedules", "owner_paused", "INTEGER NOT NULL DEFAULT 0");
      db.exec(
        "UPDATE schedules SET owner_paused = 1 WHERE owner_id IN (SELECT id FROM users WHERE disabled = 1)",
      );
    },
  },
  {
    // 客户查重（company_norm：去组织形式 / 标点后的公司名）、产品分类、回收站（软删除：deleted_at / deleted_by）
    version: 28,
    name: "customer_dedupe_soft_delete",
    up(db) {
      addColumn(db, "customers", "company_norm", "TEXT NOT NULL DEFAULT ''");
      const rows = db
        .prepare("SELECT id, company FROM customers")
        .all() as unknown as Array<{ id: string; company: string }>;
      const update = db.prepare(
        "UPDATE customers SET company_norm = ? WHERE id = ?",
      );
      for (const row of rows) update.run(companyNorm(row.company ?? ""), row.id);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_customers_company_norm ON customers(org_id, company_norm)",
      );
      // 产品库分类
      addColumn(db, "products", "category", "TEXT NOT NULL DEFAULT ''");
      // 产品库按组织隔离：已有产品归第一个组织（本机模式没有组织时保持 'local'）
      addColumn(db, "products", "org_id", "TEXT NOT NULL DEFAULT 'local'");
      db.exec(`
        UPDATE products
           SET org_id = (SELECT id FROM orgs ORDER BY created_at, rowid LIMIT 1)
         WHERE org_id = 'local' AND EXISTS (SELECT 1 FROM orgs);
        CREATE INDEX IF NOT EXISTS idx_products_org ON products(org_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_products_org_sku ON products(org_id, sku);
      `);
      for (const table of ["customers", "quotes", "deals", "orders", "tasks"]) {
        addColumn(db, table, "deleted_at", "INTEGER");
        addColumn(db, table, "deleted_by", "TEXT");
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_${table}_deleted_at ON ${table}(org_id, deleted_at)`,
        );
      }
    },
  },
  {
    // 群聊成员实例：同一内核多次进群（agent_id 带 #n 后缀），每个成员有自己的群头衔 / 职责 / 模型
    version: 29,
    name: "group_member_profiles",
    up(db) {
      addColumn(db, "session_members", "role", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "session_members", "instructions", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "session_members", "model", "TEXT");
    },
  },
  {
    // 潜客（开发客户）：客户线索与证据，转客户后 customer_id 关联；归属 / 可见性 / 回收站列与 customers 一致
    version: 30,
    name: "prospects",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS prospects (
          id TEXT PRIMARY KEY,
          company TEXT NOT NULL,
          company_key TEXT NOT NULL,
          country TEXT NOT NULL DEFAULT '',
          website TEXT NOT NULL DEFAULT '',
          website_key TEXT NOT NULL DEFAULT '',
          address TEXT NOT NULL DEFAULT '',
          products TEXT NOT NULL DEFAULT '',
          hs_codes TEXT NOT NULL DEFAULT '[]',
          emails TEXT NOT NULL DEFAULT '[]',
          phones TEXT NOT NULL DEFAULT '[]',
          social_links TEXT NOT NULL DEFAULT '[]',
          last_import_at INTEGER,
          shipments INTEGER,
          evidence TEXT NOT NULL DEFAULT '[]',
          flags TEXT NOT NULL DEFAULT '[]',
          score INTEGER NOT NULL DEFAULT 0,
          score_reasons TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'new',
          customer_id TEXT,
          search_query TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          org_id TEXT NOT NULL DEFAULT 'local',
          owner_id TEXT NOT NULL DEFAULT 'local',
          visibility TEXT NOT NULL DEFAULT 'private',
          team_id TEXT,
          deleted_at INTEGER,
          deleted_by TEXT,
          FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_prospects_updated ON prospects(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_prospects_company_key ON prospects(company_key);
        CREATE INDEX IF NOT EXISTS idx_prospects_website_key ON prospects(website_key);
        CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects(org_id, status);
        CREATE INDEX IF NOT EXISTS idx_prospects_score ON prospects(score DESC);
        CREATE INDEX IF NOT EXISTS idx_prospects_owner ON prospects(org_id, owner_id);
        CREATE INDEX IF NOT EXISTS idx_prospects_deleted_at ON prospects(org_id, deleted_at);
      `);
    },
  },
  {
    // 制裁名单筛查：存储 OFAC / EU / UN / custom 名单条目与元数据
    version: 31,
    name: "sanctions",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sanctions_entries (
          id TEXT PRIMARY KEY,
          list TEXT NOT NULL,
          ref TEXT NOT NULL,
          name TEXT NOT NULL,
          name_key TEXT NOT NULL,
          entity_type TEXT NOT NULL DEFAULT '',
          programs TEXT NOT NULL DEFAULT '',
          countries TEXT NOT NULL DEFAULT '[]',
          remarks TEXT NOT NULL DEFAULT '',
          is_alias INTEGER NOT NULL DEFAULT 0,
          primary_name TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_sanctions_entries_list ON sanctions_entries(list);
        CREATE INDEX IF NOT EXISTS idx_sanctions_entries_name_key ON sanctions_entries(name_key);
        CREATE TABLE IF NOT EXISTS sanctions_lists (
          list TEXT PRIMARY KEY,
          updated_at INTEGER,
          entry_count INTEGER,
          source_url TEXT,
          error TEXT
        );
      `);
    },
  },
  {
    // 报价引擎：汇率缓存（只按 USD 为基准存，交叉汇率现算）与运价表（按组织隔离）
    version: 32,
    name: "pricing",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS fx_rates (
          base TEXT NOT NULL,
          quote TEXT NOT NULL,
          rate REAL NOT NULL,
          source TEXT NOT NULL,
          as_of TEXT NOT NULL DEFAULT '',
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY (base, quote)
        );
        CREATE TABLE IF NOT EXISTS freight_rates (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL DEFAULT 'local',
          pol TEXT NOT NULL DEFAULT '',
          pod TEXT NOT NULL DEFAULT '',
          pod_country TEXT NOT NULL DEFAULT '',
          container TEXT NOT NULL CHECK (container IN ('20GP', '40GP', '40HQ', 'LCL')),
          price REAL NOT NULL DEFAULT 0,
          currency TEXT NOT NULL DEFAULT 'USD',
          unit TEXT NOT NULL DEFAULT 'container',
          carrier TEXT NOT NULL DEFAULT '',
          valid_from TEXT NOT NULL DEFAULT '',
          valid_until TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_freight_rates_pod ON freight_rates(org_id, pod);
      `);
    },
  },
  {
    // 询盘打分：分数、等级、明细（JSON：理由 / 标记 / 语种 / 追问项）
    version: 33,
    name: "inquiry_score",
    up(db) {
      addColumn(db, "email_messages", "inquiry_score", "INTEGER");
      addColumn(db, "email_messages", "inquiry_grade", "TEXT");
      addColumn(db, "email_messages", "inquiry_detail", "TEXT NOT NULL DEFAULT ''");
      db.exec("CREATE INDEX IF NOT EXISTS idx_email_messages_score ON email_messages(inquiry_score)");
    },
  },
  {
    // 开发信序列：序列（步骤模板 + 发送窗口）、联系人进度、每封发送（草稿 + 待确认）、退订名单
    version: 34,
    name: "outreach_sequences",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sequences (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL DEFAULT 'local',
          owner_id TEXT NOT NULL DEFAULT 'local',
          name TEXT NOT NULL,
          account_id TEXT NOT NULL,
          steps_json TEXT NOT NULL DEFAULT '[]',
          window_start INTEGER NOT NULL DEFAULT 9,
          window_end INTEGER NOT NULL DEFAULT 17,
          skip_weekends INTEGER NOT NULL DEFAULT 1,
          stop_on_company_reply INTEGER NOT NULL DEFAULT 1,
          include_optout INTEGER NOT NULL DEFAULT 1,
          auto_send INTEGER NOT NULL DEFAULT 0,
          daily_limit INTEGER NOT NULL DEFAULT 50,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_sequences_owner ON sequences(org_id, owner_id);
        CREATE TABLE IF NOT EXISTS sequence_enrollments (
          id TEXT PRIMARY KEY,
          sequence_id TEXT NOT NULL,
          email TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          company TEXT NOT NULL DEFAULT '',
          country TEXT NOT NULL DEFAULT '',
          timezone TEXT NOT NULL,
          customer_id TEXT,
          prospect_id TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          current_step INTEGER NOT NULL DEFAULT 0,
          next_send_at INTEGER,
          last_sent_at INTEGER,
          stop_reason TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (sequence_id) REFERENCES sequences(id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_seq_enroll_unique ON sequence_enrollments(sequence_id, email);
        CREATE INDEX IF NOT EXISTS idx_seq_enroll_due ON sequence_enrollments(status, next_send_at);
        CREATE INDEX IF NOT EXISTS idx_seq_enroll_email ON sequence_enrollments(email);
        CREATE TABLE IF NOT EXISTS sequence_sends (
          id TEXT PRIMARY KEY,
          enrollment_id TEXT NOT NULL,
          step_index INTEGER NOT NULL,
          draft_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          subject TEXT NOT NULL DEFAULT '',
          scheduled_at INTEGER NOT NULL,
          sent_at INTEGER,
          sent_message_id TEXT,
          error TEXT NOT NULL DEFAULT '',
          warning TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          FOREIGN KEY (enrollment_id) REFERENCES sequence_enrollments(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_seq_sends_enroll ON sequence_sends(enrollment_id);
        CREATE INDEX IF NOT EXISTS idx_seq_sends_status ON sequence_sends(status);
        CREATE TABLE IF NOT EXISTS email_suppressions (
          org_id TEXT NOT NULL DEFAULT 'local',
          email TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          PRIMARY KEY (org_id, email)
        );
      `);
    },
  },
  {
    // 出货单证资料（商业发票 / 装箱单 / 原产地证草稿）：按订单保存 JSON
    version: 35,
    name: "order_doc_info",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS order_doc_info (
          order_id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL DEFAULT 'local',
          data_json TEXT NOT NULL DEFAULT '{}',
          updated_by TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
        );
      `);
    },
  },
];

export interface MigrationOptions {
  /** 迁移前把现有库快照到该目录（VACUUM INTO） */
  backupDir?: string;
}

export interface MigrationResult {
  applied: number[];
  backupFile: string | null;
}

export function currentVersion(db: DatabaseSync): number {
  if (!tableExists(db, "schema_migrations")) return 0;
  const row = db
    .prepare("SELECT MAX(version) AS v FROM schema_migrations")
    .get() as unknown as {
    v: number | null;
  };
  return Number(row.v ?? 0);
}

export function runMigrations(
  db: DatabaseSync,
  options: MigrationOptions = {},
  migrations: Migration[] = MIGRATIONS,
): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const done = new Set(
    (
      db
        .prepare("SELECT version FROM schema_migrations")
        .all() as unknown as Array<{ version: number }>
    ).map((row) => Number(row.version)),
  );
  const pending = [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((m) => !done.has(m.version));
  const result: MigrationResult = { applied: [], backupFile: null };
  if (pending.length === 0) return result;

  // 已有业务数据的旧库，迁移前先留快照
  if (options.backupDir && tableExists(db, "providers")) {
    mkdirSync(options.backupDir, { recursive: true });
    const file = join(
      options.backupDir,
      `pre-migration-v${currentVersion(db)}-${Date.now()}.db`,
    );
    db.prepare("VACUUM INTO ?").run(file);
    result.backupFile = file;
  }

  for (const migration of pending) {
    db.exec("BEGIN");
    try {
      migration.up(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, Date.now());
      db.exec("COMMIT");
      result.applied.push(migration.version);
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(
        `数据库迁移 ${migration.version}（${migration.name}）失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return result;
}
