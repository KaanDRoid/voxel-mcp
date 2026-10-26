export const XS_TEMPLATE_KINDS = ["sdf-sphere", "sdf-box", "torus", "noise", "gradient"] as const;
export type XsTemplateKind = (typeof XS_TEMPLATE_KINDS)[number];

const PREAMBLE = `
//===== built-in args =====
// uniform vec3\t\ti_volume_size;\t\t// volume size [1-256]
// uniform float\ti_color_index;\t\t// current color index [0-255]
// uniform int\t\ti_num_color_sels;\t// number of color selections [1-255]

//===== built-in functions =====
// float voxel( vec3 v );\t\t\t\t// get voxel color index
// float color_sel( float k );\t\t\t// get kth selected color index
// vec4 palette( float index );\t\t\t// get palette color

// generate a new voxel color index [0, 255] at position v ( v is at the center of voxel, such as vec3( 1.5, 2.5, 4.5 ) )
`;

const arg = (v: string, name: string, value: string, range: string, step: string, precision: string) =>
  `// arg : { var = '${v}' name = '${name}' value = '${value}' range = '${range}' step = '${step}' precision = '${precision}' }\n`;

const BODIES: Record<XsTemplateKind, { args: string; body: string }> = {
  "sdf-sphere": {
    args: arg("m_radius", "Radius", "0.9", "0.05 1.0", "0.05", "2"),
    body: `float map( vec3 v ) {
\tvec3 half_size = i_volume_size * 0.5;
\tvec3 p = ( v - half_size ) / half_size;
\treturn i_color_index * step( length( p ), m_radius );
}
`,
  },
  "sdf-box": {
    args: arg("m_round", "Round", "2", "0 64", "0.5", "1"),
    body: `float map( vec3 v ) {
\tvec3 half_size = i_volume_size * 0.5;
\tvec3 q = abs( v - half_size ) - half_size + m_round;
\tfloat d = length( max( q, 0.0 ) ) + min( max( q.x, max( q.y, q.z ) ), 0.0 );
\tif ( d < m_round ) {
\t\treturn i_color_index;
\t}
\treturn 0.0;
}
`,
  },
  torus: {
    args: arg("m_tube", "Tube", "3", "1 64", "0.5", "1"),
    body: `float map( vec3 v ) {
\tvec3 p = v - i_volume_size * 0.5;
\tfloat major_radius = min( i_volume_size.x, i_volume_size.y ) * 0.5 - m_tube;
\tvec2 q = vec2( length( p.xy ) - major_radius, p.z );
\treturn i_color_index * step( length( q ), m_tube );
}
`,
  },
  noise: {
    args: arg("m_seed", "Seed", "1", "0 1000", "1", "0") + arg("m_density", "Density", "0.3", "0 1", "0.05", "2"),
    body: `float hash( vec3 p ) {
\treturn fract( sin( dot( p, vec3( 12.9898, 78.233, 37.719 ) ) + m_seed ) * 43758.5453 );
}

float map( vec3 v ) {
\treturn i_color_index * step( hash( floor( v ) ), m_density );
}
`,
  },
  gradient: {
    args: "",
    body: `float map( vec3 v ) {
\tfloat k = floor( v.z / i_volume_size.z * float( i_num_color_sels ) );
\treturn color_sel( k );
}
`,
  },
};

/** Build shader text that can be pasted into the MagicaVoxel shader folder. */
export function generateXsTemplate(kind: XsTemplateKind, author = "magicvoxel-mcp"): string {
  const t = BODIES[kind];
  return `// xs_begin\n// author : '${author.replace(/'/g, "")}'\n${t.args}// xs_end\n${PREAMBLE}${t.body}`;
}
