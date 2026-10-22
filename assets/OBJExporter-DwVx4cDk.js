import{F as e,P as t,d as n,f as r,j as i,x as a}from"./index-DHkGSKhy.js";var o=class{parse(o){let s=``,c=0,l=0,u=0,d=new e,f=new n,p=new e,m=new t,h=[];function g(e){let t=0,n=0,r=0,i=e.geometry,o=new a,f=i.getAttribute(`position`),g=i.getAttribute(`normal`),_=i.getAttribute(`uv`),v=i.getIndex();if(s+=`o `+e.name+`
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
`;c+=t}function v(e){let t=0,n=e.geometry,a=n.getAttribute(`position`),o=n.getAttribute(`color`);if(s+=`o `+e.name+`
`,a!==void 0){for(let n=0,c=a.count;n<c;n++,t++)d.fromBufferAttribute(a,n),d.applyMatrix4(e.matrixWorld),s+=`v `+d.x+` `+d.y+` `+d.z,o!==void 0&&(f.fromBufferAttribute(o,n),r.workingToColorSpace(f,i),s+=` `+f.r+` `+f.g+` `+f.b),s+=`
`;s+=`p `;for(let e=1,t=a.count;e<=t;e++)s+=c+e+` `;s+=`
`}c+=t}return o.traverse(function(e){e.isMesh===!0&&g(e),e.isLine===!0&&_(e),e.isPoints===!0&&v(e)}),s}};export{o as OBJExporter};