import{C as e,D as t,E as n,i as r,p as i,r as a}from"./index-D3mJ2HPI.js";var o=class{parse(o){let s=``,c=0,l=0,u=0,d=new t,f=new a,p=new t,m=new n,h=[];function g(e){let t=0,n=0,r=0,a=e.geometry,o=new i,f=a.getAttribute(`position`),g=a.getAttribute(`normal`),_=a.getAttribute(`uv`),v=a.getIndex();if(s+=`o `+e.name+`
`,e.material&&e.material.name&&(s+=`usemtl `+e.material.name+`
`),f!==void 0)for(let n=0,r=f.count;n<r;n++,t++)d.fromBufferAttribute(f,n),d.applyMatrix4(e.matrixWorld),s+=`v `+d.x+` `+d.y+` `+d.z+`
`;if(_!==void 0)for(let e=0,t=_.count;e<t;e++,r++)m.fromBufferAttribute(_,e),s+=`vt `+m.x+` `+m.y+`
`;if(g!==void 0){o.getNormalMatrix(e.matrixWorld);for(let e=0,t=g.count;e<t;e++,n++)p.fromBufferAttribute(g,e),p.applyMatrix3(o).normalize(),s+=`vn `+p.x+` `+p.y+` `+p.z+`
`}if(v!==null)for(let e=0,t=v.count;e<t;e+=3){for(let t=0;t<3;t++){let n=v.getX(e+t)+1;h[t]=c+n+(g||_?`/`+(_?l+n:``)+(g?`/`+(u+n):``):``)}s+=`f `+h.join(` `)+`
`}else for(let e=0,t=f.count;e<t;e+=3){for(let t=0;t<3;t++){let n=e+t+1;h[t]=c+n+(g||_?`/`+(_?l+n:``)+(g?`/`+(u+n):``):``)}s+=`f `+h.join(` `)+`
`}c+=t,l+=r,u+=n}function _(e){let t=0,n=e.geometry,r=e.type,i=n.getAttribute(`position`);if(s+=`o `+e.name+`
`,i!==void 0)for(let n=0,r=i.count;n<r;n++,t++)d.fromBufferAttribute(i,n),d.applyMatrix4(e.matrixWorld),s+=`v `+d.x+` `+d.y+` `+d.z+`
`;if(r===`Line`){s+=`l `;for(let e=1,t=i.count;e<=t;e++)s+=c+e+` `;s+=`
`}if(r===`LineSegments`)for(let e=1,t=e+1,n=i.count;e<n;e+=2,t=e+1)s+=`l `+(c+e)+` `+(c+t)+`
`;c+=t}function v(t){let n=0,i=t.geometry,a=i.getAttribute(`position`),o=i.getAttribute(`color`);if(s+=`o `+t.name+`
`,a!==void 0){for(let i=0,c=a.count;i<c;i++,n++)d.fromBufferAttribute(a,i),d.applyMatrix4(t.matrixWorld),s+=`v `+d.x+` `+d.y+` `+d.z,o!==void 0&&(f.fromBufferAttribute(o,i),r.workingToColorSpace(f,e),s+=` `+f.r+` `+f.g+` `+f.b),s+=`
`;s+=`p `;for(let e=1,t=a.count;e<=t;e++)s+=c+e+` `;s+=`
`}c+=n}return o.traverse(function(e){e.isMesh===!0&&g(e),e.isLine===!0&&_(e),e.isPoints===!0&&v(e)}),s}};export{o as OBJExporter};