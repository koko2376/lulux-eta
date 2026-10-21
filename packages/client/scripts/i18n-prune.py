# 删除 zh-CN.json / en.json 里代码不再引用的键
import json, re, os, sys
root = os.path.join(os.path.dirname(__file__), '..', 'src')
used = set()
prefixes = set()
for r, d, fs in os.walk(root):
    for f in fs:
        if f.endswith(('.vue', '.ts')) and not f.endswith('.test.ts'):
            text = open(os.path.join(r, f), encoding='utf8').read()
            used |= set(re.findall(r"(?:\$t|\bt)\(\s*'([a-zA-Z]\w*\.\w+)'", text))
            # 动态键：$t(`scope.prefix_${x}`)
            prefixes |= set(re.findall(r"(?:\$t|\bt)\(\s*`([a-zA-Z]\w*\.\w*)\$\{", text))
for name in ['zh-CN.json', 'en.json']:
    p = os.path.join(root, 'i18n', 'locales', name)
    z = json.load(open(p, encoding='utf8'))
    n = 0
    for sc in list(z):
        for k in list(z[sc]):
            full = f'{sc}.{k}'
            if full not in used and not any(full.startswith(p) for p in prefixes):
                del z[sc][k]; n += 1
        if not z[sc]: del z[sc]
    with open(p, 'w', encoding='utf8') as fh:
        json.dump(z, fh, ensure_ascii=False, indent=2); fh.write('\n')
    print(name, 'pruned', n, 'keys', sum(len(v) for v in z.values()))
