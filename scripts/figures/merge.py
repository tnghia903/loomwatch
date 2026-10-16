import json, struct, sys
def read(path):
    b = open(path, 'rb').read()
    jl = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + jl])
    rest = b[20 + jl:]
    bl = struct.unpack('<I', rest[0:4])[0]
    return j, bytearray(rest[8:8 + bl])
base, bbin = read(sys.argv[1]); add, abin = read(sys.argv[2])
if any(n.get('name', '').startswith(('head_scissors', 'head_bobbin')) for n in base['nodes']):
    sys.exit('already merged')
while len(bbin) % 4: bbin.append(0)
offset = len(bbin); bbin += abin
while len(bbin) % 4: bbin.append(0)
bv0 = len(base['bufferViews'])
for v in add['bufferViews']:
    v = dict(v); v['buffer'] = 0; v['byteOffset'] = v.get('byteOffset', 0) + offset; base['bufferViews'].append(v)
ac0 = len(base['accessors'])
for a in add['accessors']:
    a = dict(a); a['bufferView'] += bv0; base['accessors'].append(a)
mat_by_name = {m['name']: i for i, m in enumerate(base['materials'])}
me0 = len(base['meshes'])
for m in add['meshes']:
    m = json.loads(json.dumps(m))
    for p in m['primitives']:
        p['attributes'] = {k: v + ac0 for k, v in p['attributes'].items()}
        if 'indices' in p: p['indices'] += ac0
        p['material'] = mat_by_name[add['materials'][p['material']]['name']]
    base['meshes'].append(m)
root = add['scenes'][add.get('scene', 0)]['nodes'][0]
assert add['nodes'][root]['name'] == 'new_heads'
remap = {}
for i, n in enumerate(add['nodes']):
    if i != root: remap[i] = len(base['nodes']) + len(remap)
for i, n in enumerate(add['nodes']):
    if i == root: continue
    n = dict(n)
    if 'mesh' in n: n['mesh'] += me0
    if 'children' in n: n['children'] = [remap[c] for c in n['children']]
    base['nodes'].append(n)
head = next(i for i, n in enumerate(base['nodes']) if n.get('name') == 'head')
base['nodes'][head].setdefault('children', []).extend(remap[c] for c in add['nodes'][root]['children'])
base['buffers'][0]['byteLength'] = len(bbin)
js = json.dumps(base, separators=(',', ':')).encode()
while len(js) % 4: js += b' '
total = 12 + 8 + len(js) + 8 + len(bbin)
out = struct.pack('<III', 0x46546C67, 2, total) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(bbin), 0x004E4942) + bytes(bbin)
open(sys.argv[3], 'wb').write(out)
print('merged', len(out))
