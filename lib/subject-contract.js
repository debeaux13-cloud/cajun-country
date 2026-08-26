export const MAX_REFERENCE_SUBJECTS=12;

function clean(value){return String(value||'').replace(/\s+/g,' ').trim()}
function clipped(value,limit){const text=clean(value);if(text.length<=limit)return text;return text.slice(0,limit).replace(/\s+\S*$/,'').trim()||text.slice(0,limit)}
const AGE_GROUPS=new Set(['baby','toddler','child','teen','adult','older_adult','not_applicable']);

export function normalizeSubjects(identity){
  const listed=Array.isArray(identity?.subjects)?identity.subjects:[];
  const source=listed.length?listed:[{
    referencePosition:'principal subject from the uploaded reference',
    kind:identity?.subjectType==='person'?'person':'animal',
    apparentAgeGroup:'not_applicable',
    species:identity?.species||'reference subject',
    primaryBreedGuess:identity?.primaryBreedGuess||'',
    breedConfidence:identity?.breedConfidence||'low',
    keyMarkers:identity?.keyMarkers||[],
    identityDescription:identity?.identityDescription||'Preserve the exact visible identity from the uploaded reference',
    uncertainDetails:identity?.uncertainDetails||[]
  }];
  return source.slice(0,MAX_REFERENCE_SUBJECTS).map((subject,index)=>{
    const kind=clean(subject?.kind)||'animal';
    const suppliedAge=clean(subject?.apparentAgeGroup);
    return{
      subjectId:`S${index+1}`,
      storyIdentity:clean(subject?.storyIdentity),
      referencePosition:clean(subject?.referencePosition)||`subject ${index+1} from the left`,
      kind,
      apparentAgeGroup:kind==='person'&&AGE_GROUPS.has(suppliedAge)?suppliedAge:'not_applicable',
      species:clean(subject?.species)||kind,
      primaryBreedGuess:clean(subject?.primaryBreedGuess),
      breedConfidence:clean(subject?.breedConfidence)||'low',
      keyMarkers:(Array.isArray(subject?.keyMarkers)?subject.keyMarkers:[]).map(clean).filter(Boolean),
      identityDescription:clean(subject?.identityDescription),
      uncertainDetails:(Array.isArray(subject?.uncertainDetails)?subject.uncertainDetails:[]).map(clean).filter(Boolean)
    };
  });
}

function shortSubject(subject,includeBreed=true){
  const storyIdentity=clipped(subject.storyIdentity,12);
  const personType=subject.apparentAgeGroup&&subject.apparentAgeGroup!=='not_applicable'?`${subject.apparentAgeGroup.replace('_',' ')} person`:'person';
  const species=clipped(subject.kind==='person'?personType:includeBreed?(subject.species||subject.kind||'animal'):(subject.kind||'animal'),18).toLowerCase();
  const breed=includeBreed&&subject.kind!=='person'&&subject.primaryBreedGuess&&!/^(unknown|not applicable|n\/a|animal)$/i.test(subject.primaryBreedGuess)
    ?clipped(subject.primaryBreedGuess,16)
    :'';
  return`${subject.subjectId}=${storyIdentity?`${storyIdentity}/`:''}${[breed,species].filter(Boolean).join(' ')}`;
}

export function compactSubjectRoster(identity,maxLength=155){
  const subjects=normalizeSubjects(identity);
  let roster=subjects.map(subject=>shortSubject(subject,true)).join('; ');
  if(roster.length>maxLength)roster=subjects.map(subject=>shortSubject(subject,false)).join('; ');
  if(roster.length>maxLength){
    const separators=Math.max(0,subjects.length-1)*2;
    const fixed=subjects.reduce((total,subject)=>total+subject.subjectId.length+3,0)+separators;
    const aliasLimit=Math.max(1,Math.floor((maxLength-fixed)/Math.max(1,subjects.length)));
    roster=subjects.map(subject=>{
      const ageCodes={baby:'B',toddler:'Td',child:'Ch',teen:'T',adult:'Ad',older_adult:'OA'};
      const code=subject.kind==='person'?(ageCodes[subject.apparentAgeGroup]||'P'):subject.kind==='dog'?'D':subject.kind==='cat'?'C':'A';
      const alias=clipped(subject.storyIdentity,aliasLimit);
      return`${subject.subjectId}=${alias?`${alias}/`:''}${code}`;
    }).join('; ');
  }
  return roster;
}

export function subjectContract(identity){
  const subjects=normalizeSubjects(identity);
  const subjectType=clean(identity?.subjectType)||(
    subjects.some(subject=>subject.kind==='person')&&subjects.some(subject=>subject.kind!=='person')?'mixed':
    subjects.every(subject=>subject.kind==='person')?(subjects.length===1?'person':'people'):
    subjects.length===1?'pet':'pets'
  );
  const roster=subjects.map(subject=>({
    subject_id:subject.subjectId,
    reference_position:subject.referencePosition,
    kind:subject.kind,
    apparent_age_group:subject.apparentAgeGroup,
    species:subject.species,
    breed_or_type:subject.primaryBreedGuess,
    confidence:subject.breedConfidence,
    visible_markers:subject.keyMarkers,
    exact_identity:subject.identityDescription,
    obscured_do_not_invent:subject.uncertainDetails
  }));
  const traits=subjects.map(subject=>{
    const breed=subject.primaryBreedGuess?` ${subject.primaryBreedGuess}`:'';
    const markers=subject.keyMarkers.slice(0,3).join(', ');
    const exact=clipped(subject.identityDescription,140);
    const age=subject.kind==='person'&&subject.apparentAgeGroup!=='not_applicable'?`; apparent age group ${subject.apparentAgeGroup}`:'';
    return`${subject.subjectId} (${subject.referencePosition}): ${subject.species}${breed}${age}${markers?`; ${markers}`:''}${exact?`; ${exact}`:''}`;
  });
  return{
    subject_count:subjects.length,
    subject_type:subjectType,
    species:clean(identity?.species)||[...new Set(subjects.map(subject=>subject.species).filter(Boolean))].join(', '),
    breed:clean(identity?.primaryBreedGuess)||'preserve each subject from reference',
    subject_roster:roster,
    apparent_age_groups:Object.fromEntries(subjects.map(subject=>[subject.subjectId,subject.apparentAgeGroup])),
    traits,
    hard_constraints:[
      `Give every one of the ${subjects.length} identified subjects at least one visible, recognizable appearance during the film; each scene shows only the uploaded subject IDs listed in that scene's screenplay`,
      `Whenever present, keep S1-S${subjects.length} assignments exact, stable, and distinct; never merge, swap, hybridize, average, duplicate, add, omit, or transfer traits between listed subjects`,
      'Preserve each subject independently: species, breed/type, anatomy, face or muzzle, body proportions, colors, markings, hair or fur, ears, tail, clothing, and accessories',
      'Preserve every person’s apparent age group; keep babies, toddlers, children, and teens visibly age-appropriate and never age them into adults',
      'Treat the uploaded group photo as identity reference only; never reuse its background as a scene composition'
    ],
    subject_details:roster,
    customer_notes:''
  };
}
