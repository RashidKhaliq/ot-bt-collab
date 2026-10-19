export const numeric=v=>Number.isFinite(Number(v))?Number(v):0;
function day(offset=0){const date=new Date();date.setUTCDate(date.getUTCDate()+offset);return date.toISOString().slice(0,10)}
export function dateRange(input={}){
 const period=String(input.period||'30');let from,to;
 if(period==='today'){from=to=day(0)}else if(period==='yesterday'){from=to=day(-1)}
 else if(period==='7'){from=day(-6);to=day(0)}else if(period==='90'){from=day(-89);to=day(0)}
 else if(period==='custom'){from=String(input.from||'');to=String(input.to||'')}
 else{from=day(-29);to=day(0)}
 if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to||from<day(-370)||to>day(0)||Number.isNaN(Date.parse(from))||Number.isNaN(Date.parse(to)))throw new Error('Invalid date window');
 return {from,to};
}
