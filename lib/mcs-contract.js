export const PRODUCTION_ORIGIN='https://main-character-studios.vercel.app';
export const MOODS=Object.freeze(['surprise me','funny','silly','dramatic','spooky','romantic']);
export const MOOD_SET=new Set(MOODS);
export const MCS_VISUAL_STYLE='Polished modern stylized 3D CGI animated-feature rendering; sculpted volume and depth; soft cinematic environmental lighting; dimensional materials and textures; natural appealing proportions; expressive without exaggerated cartoon anatomy; between photoreal live action and flat illustration.';
export const MCS_NEGATIVE_STYLE='No flat 2D cartoon, children’s-book watercolor, painterly storybook, clip-art, collage, default gothic horror, spooky distortion, uncanny photoreal humans or animals, oversized cartoon features, species hybrids, or anatomy drift.';
export const PRODUCT_OUTPUT=Object.freeze({aspectRatio:'3:4',width:960,height:1280,sceneSeconds:10,previewScenes:6,fullScenes:18,previewSeconds:60,fullSeconds:180});
export function normalizeMoods(value){
 const items=Array.isArray(value)?value:[value];
 const moods=[...new Set(items.map(v=>String(v??'').trim().toLowerCase()).filter(v=>MOOD_SET.has(v)))];
 if(items.filter(v=>String(v??'').trim()).length&&!moods.length)throw new Error('Choose a supported Main Character Studios mood.');
 return moods.length?moods:['surprise me'];
}
