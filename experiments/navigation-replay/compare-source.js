async () => {
 const source=window.__middleReplayProbe;
 if(!source)throw new Error('No baseline');
 const after=await source.capture();
 return {equal:Object.fromEntries(Object.keys(after).map(k=>[k,JSON.stringify(after[k])===JSON.stringify(source.baseline[k])])),clicks:source.clicks,navigations:source.navigations,before:source.baseline,after};
}
