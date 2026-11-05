async () => {
 const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');
 const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
 const source = { clicks:0, navigations:[], nodes:new WeakMap(), nextNode:1 };
 const nodeKey=e=>{if(!source.nodes.has(e))source.nodes.set(e,source.nextNode++);return source.nodes.get(e);};
 source.capture=async()=>({
  url:location.href,title:document.title,entryKey:navigation.currentEntry?.key,
  historyState:await digest(JSON.stringify(history.state)),
  visibleMain:await digest(JSON.stringify([...document.querySelectorAll('main,[role="main"]')].filter(visible).map(e=>[nodeKey(e),e.innerText]))),
  visibleInputs:await digest(JSON.stringify([...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(visible).map(e=>[nodeKey(e),e.getAttribute('aria-label'),e.value??e.textContent]))),
  selection:await digest(JSON.stringify([...document.querySelectorAll('[aria-current],[data-selected],[aria-selected="true"]')].filter(visible).map(e=>[nodeKey(e),e.getAttribute('aria-current'),e.getAttribute('data-selected'),e.getAttribute('aria-selected')]))),
  scroll:JSON.stringify([...document.querySelectorAll('body,main,main *,nav,nav *,aside,aside *')].filter(e=>visible(e)&&/(?:auto|scroll)/.test(getComputedStyle(e).overflowY)&&e.scrollHeight>e.clientHeight+10).map(e=>[nodeKey(e),e.scrollTop,e.scrollLeft])),
  viewport:[innerWidth,innerHeight,devicePixelRatio],
  focus:nodeKey(document.activeElement),
  markerVisible:[...document.querySelectorAll('textarea,[contenteditable="true"]')].some(e=>visible(e)&&(e.value??e.textContent).includes('REPLAY UNSENT TEST'))
 });
 source.clickHandler=e=>{if(e.button===0)source.clicks++;};
 source.navigationHandler=e=>source.navigations.push({url:e.destination.url,type:e.navigationType});
 document.addEventListener('click',source.clickHandler,true);
 navigation.addEventListener('navigate',source.navigationHandler);
 source.baseline=await source.capture();
 window.__middleReplayProbe=source;
 return source.baseline;
}
