import { ShaderMaterial, TextureLoader, UniformsLib } from 'three'

const vertexShader = `
#define PHONG
varying vec3 vViewPosition;
#ifndef FLAT_SHADED
	varying vec3 vNormal;
#endif
#include <common>
#include <uv_pars_vertex>
#include <uv2_pars_vertex>
#include <displacementmap_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <uv2_vertex>
	#include <color_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
#ifndef FLAT_SHADED // Normal computed with derivatives when FLAT_SHADED
	vNormal = normalize( transformedNormal );
#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}
`

const fragmentShader = `
#define PHONG
#ifndef FLAT_SHADED
	varying vec3 vNormal;
#endif
uniform vec3 diffuse;
uniform vec3 emissive;
uniform vec3 specular;
uniform float shininess;
uniform float opacity;
// ####### custom uniforms #########
uniform sampler2D mapNW;
uniform sampler2D mapSW;
uniform sampler2D mapNE;
uniform sampler2D mapSE;
// #################################
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <uv2_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <cube_uv_reflection_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <lights_phong_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( diffuse, opacity );
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
  #ifdef USE_MAP
  vec4 colorSW = mix(mix(texture2D(mapSW, vUv * 2.), vec4(0.), step(0.5, vUv.x)), vec4(0.), step(0.5, vUv.y));
  vec4 colorNW = mix(mix(texture2D(mapNW, vUv * 2. + vec2(0., -1.)), vec4(0.), step(0.5, vUv.x)), vec4(0.), 1. - step(0.5, vUv.y));
  vec4 colorSE = mix(mix(texture2D(mapSE, vUv * 2. + vec2(-1., 0.)), vec4(0.), 1. - step(0.5, vUv.x)), vec4(0.), step(0.5, vUv.y));
  vec4 colorNE = mix(mix(texture2D(mapNE, vUv * 2. + vec2(-1., -1.)), vec4(0.), 1. - step(0.5, vUv.x)), vec4(0.), 1. - step(0.5, vUv.y));
  // texelColor = mapTexelToLinear(texelColor);
  diffuseColor *= colorSW + colorNW + colorNE + colorSE;
  #endif
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <specularmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	// accumulation
	#include <lights_phong_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	// modulation
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + reflectedLight.indirectSpecular + totalEmissiveRadiance;
	#include <envmap_fragment>
	gl_FragColor = vec4( outgoingLight, diffuseColor.a );
	#include <tonemapping_fragment>
	#include <encodings_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}
`

const loader = new TextureLoader()

export type QuadTextureMaterialOptions = {
  lights: boolean
  wireframe: boolean
  fog: boolean
}

export const defaultTextureOptions: QuadTextureMaterialOptions = {
  lights: true,
  wireframe: false,
  fog: true
}

export const QuadTextureMaterial = (
  urls: string[],
  options: Partial<QuadTextureMaterialOptions> = {}
) => {
  return Promise.all(urls.map((url) => loader.loadAsync(url))).then((maps) => {
    const opts = {
      uniforms: {
        mapNW: { value: maps[0] },
        mapSW: { value: maps[1] },
        mapNE: { value: maps[2] },
        mapSE: { value: maps[3] },
        ...UniformsLib.common,
        ...UniformsLib.lights,
        ...UniformsLib.fog
      },
      vertexShader,
      fragmentShader,
      defines: {
        USE_MAP: true,
        USE_UV: true
      }
    }

    return new ShaderMaterial({
      ...opts,
      ...Object.assign(defaultTextureOptions, options)
    })
  })
}
