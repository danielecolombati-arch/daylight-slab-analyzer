import rhino3dm as r
f = r.File3dm()
f.Settings.ModelUnitSystem = r.UnitSystem.Millimeters
def layer(name, rgb):
    L = r.Layer(); L.Name = name; L.Color = (*rgb, 255); return f.Layers.Add(L)
ls = layer("A-SOLAI", (200,180,150)); lw = layer("A-MURI", (220,220,220)); lg = layer("A-VETRI", (120,170,220))
def boxmesh(x0,y0,z0,x1,y1,z1):
    m = r.Mesh()
    for v in [(x0,y0,z0),(x1,y0,z0),(x1,y1,z0),(x0,y1,z0),(x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1)]: m.Vertices.Add(*v)
    for q in [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]: m.Faces.AddFace(*q)
    return m
def add(m, li):
    a = r.ObjectAttributes(); a.LayerIndex = li; f.Objects.AddMesh(m, a)
W,D,H,T = 8000,6000,3000,300
add(boxmesh(0,0,-T,W,D,0), ls); add(boxmesh(0,0,H,W,D,H+T), ls)
add(boxmesh(0,D-200,0,W,D,H), lw); add(boxmesh(0,0,0,200,D,H), lw); add(boxmesh(W-200,0,0,W,D,H), lw)
# south wall with window 1500..6500 x 800..2500
add(boxmesh(0,0,0,W,200,800), lw); add(boxmesh(0,0,2500,W,200,H), lw)
add(boxmesh(0,0,800,1500,200,2500), lw); add(boxmesh(6500,0,800,W,200,2500), lw)
g = r.Mesh()
for v in [(1500,100,800),(6500,100,800),(6500,100,2500),(1500,100,2500)]: g.Vertices.Add(*v)
g.Faces.AddFace(0,1,2,3); add(g, lg)
# a brep without render mesh
bb = r.BoundingBox(r.Point3d(-3000,-3000,0), r.Point3d(-2000,-2000,1000))
a = r.ObjectAttributes(); a.LayerIndex = lw
f.Objects.AddBrep(r.Brep.CreateFromBox(r.Box(bb)), a)
f.Write("room_mm.3dm", 7); print("ok")
