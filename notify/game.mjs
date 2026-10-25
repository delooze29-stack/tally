// Copied from the game so the notification shows the same clue players will see. Keep in step with beta/index.html.
function rng(seed){return function(){seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function puzzle(seed){
  const r=rng(seed);const code=[];
  for(let i=0;i<LEN;i++)code.push(Math.floor(r()*10));
  return {code:code.join(''),clue:mathsClue(code,r)};
}
const P=['1st','2nd','3rd','4th','5th'];
function mathsClue(c,r){
  const pick=n=>Math.floor(r()*n), special=[];
  for(let i=0;i<5;i++)for(let j=0;j<5;j++){
    if(i===j)continue;
    if(c[j]!==0&&c[j]===2*c[i])special.push(`The ${P[j]} digit is double the ${P[i]}`);
    if(j>i)for(let k=0;k<5;k++){if(k!==i&&k!==j&&c[i]+c[j]===c[k])special.push(`The ${P[i]} and ${P[j]} digits add up to the ${P[k]} digit`)}
  }
  if(special.length&&r()<0.6)return special[pick(special.length)];
  let i=pick(5),j=pick(4);if(j>=i)j++;if(j<i)[i,j]=[j,i];
  const t=pick(4);
  if(t===0)return `The ${P[i]} and ${P[j]} digits add up to ${c[i]+c[j]}`;
  if(t===1&&c[i]*c[j]>0)return `The ${P[i]} and ${P[j]} digits multiply to ${c[i]*c[j]}`;
  if(t===2&&c[i]!==c[j]){const[a,b]=c[i]>c[j]?[i,j]:[j,i];return `The ${P[a]} digit is ${c[a]-c[b]} more than the ${P[b]}`}
  return `All five digits add up to ${c.reduce((x,y)=>x+y,0)}`;
}
function londonParts(t){
  try{const o={};new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'})
    .formatToParts(new Date(t)).forEach(p=>o[p.type]=p.value);return {y:+o.year,m:+o.month,d:+o.day,h:+o.hour%24}}
  catch(e){const d=new Date(t);return {y:d.getFullYear(),m:d.getMonth()+1,d:d.getDate(),h:d.getHours()}}
}
function roundAt(t){const p=londonParts(t);const d=Math.round((Date.UTC(p.y,p.m-1,p.d)-Date.UTC(2026,9,23))/864e5);return d*2+(p.h>=20?2:p.h>=8?1:0)}
const LEN=5;
export {puzzle, roundAt, londonParts};
