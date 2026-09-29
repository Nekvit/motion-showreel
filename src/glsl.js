// Shared GLSL snippets. Concatenate what you need into a shader:
//   const frag = `${GLSL.common}${GLSL.noise}${GLSL.sdf} ... void main(){...}`;
// All functions are prefixed-free but chosen to avoid collisions with
// typical shot-local names.

export const common = /* glsl */`
#ifndef SR_COMMON
#define SR_COMMON
#define PI 3.14159265359
#define TAU 6.28318530718
float saturate(float x){ return clamp(x,0.0,1.0); }
vec3  saturate(vec3 x){ return clamp(x,0.0,1.0); }
float remap(float x,float a,float b,float c,float d){ return c+(d-c)*(x-a)/(b-a); }
float remapc(float x,float a,float b,float c,float d){ return c+(d-c)*saturate((x-a)/(b-a)); }
float lstep(float a,float b,float x){ return saturate((x-a)/(b-a)); }
mat2  rot2(float a){ float c=cos(a),s=sin(a); return mat2(c,s,-s,c); }
mat3  rotX(float a){ float c=cos(a),s=sin(a); return mat3(1,0,0, 0,c,s, 0,-s,c); }
mat3  rotY(float a){ float c=cos(a),s=sin(a); return mat3(c,0,-s, 0,1,0, s,0,c); }
mat3  rotZ(float a){ float c=cos(a),s=sin(a); return mat3(c,s,0, -s,c,0, 0,0,1); }
float luma(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }
// Exact piecewise sRGB transfer functions (IEC 61966-2-1), not pow 2.2.
// srgb2lin = EOTF (sRGB code 0..1 -> linear), lin2srgb = OETF (linear -> code).
float srgb2lin(float c){ return c<=0.04045 ? c/12.92 : pow((c+0.055)/1.055, 2.4); }
vec3  srgb2lin(vec3 c){ return mix(pow(max((c+0.055)/1.055, 0.0), vec3(2.4)), c/12.92, lessThanEqual(c, vec3(0.04045))); }
float lin2srgb(float c){ c=max(c,0.0); return c<=0.0031308 ? c*12.92 : 1.055*pow(c, 1.0/2.4)-0.055; }
vec3  lin2srgb(vec3 c){ c=max(c,0.0); return mix(1.055*pow(c, vec3(1.0/2.4))-0.055, c*12.92, lessThanEqual(c, vec3(0.0031308))); }
// hex colour literal helper -> LINEAR colour through the exact EOTF: hexc(0xFF3A1F)
vec3  hexc(int h){ return srgb2lin(vec3(float((h>>16)&255),float((h>>8)&255),float(h&255))/255.0); }
// Inigo Quilez cosine palette
vec3  ipal(float t, vec3 a, vec3 b, vec3 c, vec3 d){ return a + b*cos(TAU*(c*t+d)); }
// Easing (GLSL mirrors of ease.js)
float easeInOutCubic(float x){ x=saturate(x); return x<0.5?4.0*x*x*x:1.0-pow(-2.0*x+2.0,3.0)/2.0; }
float easeOutExpo(float x){ x=saturate(x); return x>=1.0?1.0:1.0-pow(2.0,-10.0*x); }
float easeInExpo(float x){ x=saturate(x); return x<=0.0?0.0:pow(2.0,10.0*x-10.0); }
float easeInOutExpo(float x){ x=saturate(x); return x<=0.0?0.0:x>=1.0?1.0:x<0.5?pow(2.0,20.0*x-10.0)/2.0:(2.0-pow(2.0,-20.0*x+10.0))/2.0; }
float easeOutQuint(float x){ x=saturate(x); return 1.0-pow(1.0-x,5.0); }
float easeInQuint(float x){ x=saturate(x); return x*x*x*x*x; }
float easeOutBack(float x){ x=saturate(x); float c1=1.70158, c3=c1+1.0; return 1.0+c3*pow(x-1.0,3.0)+c1*pow(x-1.0,2.0); }
// Anti-aliased fill of a signed distance given in pixels-ish units.
float aastep(float d){ float w=fwidth(d); return saturate(0.5 - d/max(w,1e-5)); }
#endif
`;

export const hash = /* glsl */`
#ifndef SR_HASH
#define SR_HASH
// PCG-ish integer hashes: stable across GPUs (important for deterministic renders)
uint pcg(uint v){ uint s=v*747796405u+2891336453u; uint w=((s>>((s>>28u)+4u))^s)*277803737u; return (w>>22u)^w; }
uvec2 pcg2(uvec2 v){ v=v*1664525u+1013904223u; v.x+=v.y*1664525u; v.y+=v.x*1664525u; v^=v>>16u; v.x+=v.y*1664525u; v.y+=v.x*1664525u; v^=v>>16u; return v; }
uvec3 pcg3(uvec3 v){ v=v*1664525u+1013904223u; v.x+=v.y*v.z; v.y+=v.z*v.x; v.z+=v.x*v.y; v^=v>>16u; v.x+=v.y*v.z; v.y+=v.z*v.x; v.z+=v.x*v.y; return v; }
float hash11(float p){ return float(pcg(floatBitsToUint(p)))/4294967295.0; }
float hash12(vec2 p){ uvec2 q=pcg2(floatBitsToUint(p)); return float(q.x^q.y)/4294967295.0; }
vec2  hash22(vec2 p){ return vec2(pcg2(floatBitsToUint(p)))/4294967295.0; }
float hash13(vec3 p){ uvec3 q=pcg3(floatBitsToUint(p)); return float(q.x^q.y^q.z)/4294967295.0; }
vec3  hash33(vec3 p){ return vec3(pcg3(floatBitsToUint(p)))/4294967295.0; }
float ihash(int i){ return float(pcg(uint(i)))/4294967295.0; }
vec3  ihash3(int i){ return vec3(pcg3(uvec3(uint(i),uint(i)*7u+3u,uint(i)*13u+11u)))/4294967295.0; }
#endif
`;

export const noise = hash + /* glsl */`
#ifndef SR_NOISE
#define SR_NOISE
// Value noise
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),u.x), mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),u.x), u.y); }
float vnoise(vec3 p){ vec3 i=floor(p), f=fract(p); vec3 u=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash13(i),hash13(i+vec3(1,0,0)),u.x),mix(hash13(i+vec3(0,1,0)),hash13(i+vec3(1,1,0)),u.x),u.y),
             mix(mix(hash13(i+vec3(0,0,1)),hash13(i+vec3(1,0,1)),u.x),mix(hash13(i+vec3(0,1,1)),hash13(i+vec3(1,1,1)),u.x),u.y),u.z); }
// Simplex noise 2D/3D (Ashima / Stefan Gustavson), range ~[-1,1]
vec3 _m289(vec3 x){ return x-floor(x*(1.0/289.0))*289.0; }
vec4 _m289(vec4 x){ return x-floor(x*(1.0/289.0))*289.0; }
vec2 _m289(vec2 x){ return x-floor(x*(1.0/289.0))*289.0; }
vec3 _perm(vec3 x){ return _m289(((x*34.0)+10.0)*x); }
vec4 _perm(vec4 x){ return _m289(((x*34.0)+10.0)*x); }
vec4 _tis(vec4 r){ return 1.79284291400159-0.85373472095314*r; }
float snoise(vec2 v){
  const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
  vec2 i=floor(v+dot(v,C.yy)); vec2 x0=v-i+dot(i,C.xx);
  vec2 i1=(x0.x>x0.y)?vec2(1,0):vec2(0,1);
  vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1; i=_m289(i);
  vec3 p=_perm(_perm(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));
  vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0); m=m*m; m=m*m;
  vec3 x=2.0*fract(p*C.www)-1.0; vec3 h=abs(x)-0.5; vec3 ox=floor(x+0.5); vec3 a0=x-ox;
  m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);
  vec3 g; g.x=a0.x*x0.x+h.x*x0.y; g.yz=a0.yz*x12.xz+h.yz*x12.yw; return 130.0*dot(m,g);
}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy; i=_m289(i);
  vec4 p=_perm(_perm(_perm(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw); vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0)); vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=_tis(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3))); p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.5-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 105.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec2 p){ float a=0.5, s=0.0; mat2 r=mat2(0.8,0.6,-0.6,0.8); for(int i=0;i<5;i++){ s+=a*snoise(p); p=r*p*2.03+17.1; a*=0.5; } return s; }
float fbm(vec3 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*snoise(p); p=p*2.03+vec3(17.1,-3.7,9.2); a*=0.5; } return s; }
float fbm3(vec3 p){ float a=0.5, s=0.0; for(int i=0;i<3;i++){ s+=a*snoise(p); p=p*2.03+vec3(17.1,-3.7,9.2); a*=0.5; } return s; }
// Divergence-free 2D curl of simplex noise
vec2 curl2(vec2 p){ const float e=0.01; float n1=snoise(p+vec2(0,e)), n2=snoise(p-vec2(0,e)), n3=snoise(p+vec2(e,0)), n4=snoise(p-vec2(e,0)); return vec2(n1-n2, -(n3-n4))/(2.0*e); }
// 3D curl noise
vec3 curl3(vec3 p){ const float e=0.05;
  vec3 dx=vec3(e,0,0), dy=vec3(0,e,0), dz=vec3(0,0,e);
  float x = (snoise(p+dy+vec3(31.4))-snoise(p-dy+vec3(31.4))) - (snoise(p+dz+vec3(-7.1))-snoise(p-dz+vec3(-7.1)));
  float y = (snoise(p+dz)-snoise(p-dz)) - (snoise(p+dx+vec3(31.4))-snoise(p-dx+vec3(31.4)));
  float z = (snoise(p+dx+vec3(-7.1))-snoise(p-dx+vec3(-7.1))) - (snoise(p+dy)-snoise(p-dy));
  return vec3(x,y,z)/(2.0*e); }
// Voronoi: returns (F1 distance, F2 distance, cell id hash)
vec3 voronoi(vec2 p){ vec2 n=floor(p), f=fract(p); float d1=8.0, d2=8.0, id=0.0;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){ vec2 g=vec2(i,j); vec2 o=hash22(n+g); vec2 r=g+o-f; float d=dot(r,r);
    if(d<d1){ d2=d1; d1=d; id=hash12(n+g); } else if(d<d2){ d2=d; } }
  return vec3(sqrt(d1), sqrt(d2), id); }
#endif
`;

export const sdf = /* glsl */`
#ifndef SR_SDF
#define SR_SDF
// 2D
float sdCircle(vec2 p,float r){ return length(p)-r; }
float sdBox2(vec2 p,vec2 b){ vec2 d=abs(p)-b; return length(max(d,0.0))+min(max(d.x,d.y),0.0); }
float sdRoundBox2(vec2 p,vec2 b,float r){ vec2 q=abs(p)-b+r; return min(max(q.x,q.y),0.0)+length(max(q,0.0))-r; }
float sdSegment(vec2 p,vec2 a,vec2 b){ vec2 pa=p-a, ba=b-a; float h=saturate(dot(pa,ba)/dot(ba,ba)); return length(pa-ba*h); }
float sdRing(vec2 p,float r,float w){ return abs(length(p)-r)-w; }
float sdTri2(vec2 p,float r){ const float k=sqrt(3.0); p.x=abs(p.x)-r; p.y=p.y+r/k; if(p.x+k*p.y>0.0) p=vec2(p.x-k*p.y,-k*p.x-p.y)/2.0; p.x-=clamp(p.x,-2.0*r,0.0); return -length(p)*sign(p.y); }
float sdNgon(vec2 p,float r,float n){ float a=atan(p.x,p.y)+PI; float b=TAU/n; return cos(floor(0.5+a/b)*b-a)*length(p)-r; }
// 3D
float sdSphere(vec3 p,float r){ return length(p)-r; }
float sdBox(vec3 p,vec3 b){ vec3 q=abs(p)-b; return length(max(q,0.0))+min(max(q.x,max(q.y,q.z)),0.0); }
float sdRoundBox(vec3 p,vec3 b,float r){ vec3 q=abs(p)-b+r; return length(max(q,0.0))+min(max(q.x,max(q.y,q.z)),0.0)-r; }
float sdTorus(vec3 p,vec2 t){ vec2 q=vec2(length(p.xz)-t.x,p.y); return length(q)-t.y; }
float sdCapsule(vec3 p,vec3 a,vec3 b,float r){ vec3 pa=p-a, ba=b-a; float h=saturate(dot(pa,ba)/dot(ba,ba)); return length(pa-ba*h)-r; }
float sdCylinder(vec3 p,float h,float r){ vec2 d=abs(vec2(length(p.xz),p.y))-vec2(r,h); return min(max(d.x,d.y),0.0)+length(max(d,0.0)); }
float sdOctahedron(vec3 p,float s){ p=abs(p); return (p.x+p.y+p.z-s)*0.57735027; }
float sdPlane(vec3 p,vec3 n,float h){ return dot(p,n)+h; }
// Ops
float opU(float a,float b){ return min(a,b); }
float opS(float a,float b){ return max(a,-b); }
float opI(float a,float b){ return max(a,b); }
float smin(float a,float b,float k){ float h=max(k-abs(a-b),0.0)/k; return min(a,b)-h*h*k*0.25; }
float smax(float a,float b,float k){ return -smin(-a,-b,k); }
vec2  opRep2(vec2 p,vec2 c){ return mod(p+0.5*c,c)-0.5*c; }
vec3  opRep(vec3 p,vec3 c){ return mod(p+0.5*c,c)-0.5*c; }
#endif
`;

// Camera / ray helpers for raymarching shots.
export const ray = /* glsl */`
#ifndef SR_RAY
#define SR_RAY
// Build a ray for pixel uv in [0,1]^2 with aspect, from ro looking at ta, vertical fov in radians, roll.
vec3 camRay(vec2 uv, float aspect, vec3 ro, vec3 ta, float fov, float roll){
  vec2 p=(uv*2.0-1.0); p.x*=aspect;
  vec3 ww=normalize(ta-ro); vec3 up=vec3(sin(roll),cos(roll),0.0);
  vec3 uu=normalize(cross(ww,up)); vec3 vv=cross(uu,ww);
  return normalize(p.x*uu + p.y*vv + ww/tan(fov*0.5));
}
float fresnelSchlick(float cosT, float f0){ return f0 + (1.0-f0)*pow(1.0-saturate(cosT),5.0); }
// Thin-film style iridescence tint from view angle
vec3 iridescence(float cosT, float thickness){ float d=thickness*(1.0-cosT*0.5); return 0.5+0.5*cos(TAU*(vec3(0.0,0.33,0.67)+d)); }
#endif
`;

// Everything at once, for convenience.
export const all = common + noise + sdf + ray;

export default { common, hash, noise, sdf, ray, all };
