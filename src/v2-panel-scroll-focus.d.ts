interface Node {readonly id?:string;readonly parent?:Node|null;readonly isDestroyed?:boolean}
interface Scroll extends Node {focus():void}
export declare function bindPanelScrollFocus(options:{
 renderer:{readonly currentFocusedRenderable?:Node|null;on(event:string,listener:()=>void):unknown;off(event:string,listener:()=>void):unknown},
 event:string,enabled:()=>boolean,readScroll:()=>Scroll|undefined,enqueue?:(task:()=>void)=>void
}):{request():void;dispose():void};
