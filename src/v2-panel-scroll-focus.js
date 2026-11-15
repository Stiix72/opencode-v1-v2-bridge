/** Forward an active native panel's outer-box focus to its existing scrollbox.
 * No key bindings, scrolling, redraw requests or output mutations are installed.
 * A microtask waits for Renderable.focus() to finish installing its listeners.
 */
export function bindPanelScrollFocus({renderer,event,enabled,readScroll,enqueue=queueMicrotask}){
 if(typeof renderer?.on!=='function'||typeof renderer?.off!=='function'||!event)throw new TypeError('Native panel focus events required')
 let disposed=false,pending=false
 const eligible=()=>{
  if(disposed||!enabled())return
  const scroll=readScroll(),focused=renderer.currentFocusedRenderable
  if(!scroll||scroll.isDestroyed||!focused||focused===scroll||focused.id!=='session-panel')return
  const seen=new Set()
  for(let node=scroll.parent;node&&!seen.has(node);node=node.parent){
   if(node===focused)return scroll
   seen.add(node)
  }
 }
 const request=()=>{
  if(pending||!eligible())return
  pending=true
  enqueue(()=>{pending=false;const scroll=eligible();if(scroll)scroll.focus()})
 }
 renderer.on(event,request)
 return {request,dispose(){if(disposed)return;disposed=true;renderer.off(event,request)}}
}
