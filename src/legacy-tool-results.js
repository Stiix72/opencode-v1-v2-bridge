/** V1 result records contain textual output, not native schema-declared output. */
import {copy,record,LEGACY_TITLE_METADATA_KEY} from './tool-result-data.js'
import {durableLegacyMetadata} from './legacy-metadata-durability.js'

const exposure=options=>{
  const mode=options?.toolExposure??'direct'
  if(!['direct','code-mode'].includes(mode))throw new TypeError('toolExposure must be direct or code-mode')
  return mode
}
const keys=(value,allowed,label)=>{
  if(Object.keys(value).some(key=>!allowed.includes(key)))throw new TypeError(`${label}: unsupported field`)
}
const text=(value,label)=>{if(typeof value!=='string')throw new TypeError(`${label} must be a string`);return value}
const nonempty=(value,label)=>{text(value,label);if(!value.length)throw new TypeError(`${label} must not be empty`);return value}

function contentPart(part,mode){
  if(!record(part))throw new TypeError('Native content part must be a record')
  if(part.type==='text'){
    keys(part,['type','text'],'Native text part');text(part.text,'Native text')
    return {type:'text',text:part.text}
  }
  if(part.type!=='file')throw new TypeError('Unsupported native content type')
  keys(part,['type','uri','mime','name'],'Native file part')
  nonempty(part.uri,'File URI');nonempty(part.mime,'File MIME')
  if(part.name!==undefined)text(part.name,'File name')
  // Exact CodeModeTool.outputFiles only collects this prefix. Never silently
  // lose an attachment, dereference a URL, read a file or invent its bytes.
  if(mode==='code-mode'&&!part.uri.startsWith(`data:${part.mime};base64,`))throw new TypeError('CodeMode cannot retain this file URI; exact MIME-matched base64 data URI required')
  return {type:'file',uri:part.uri,mime:part.mime,...(part.name===undefined?{}:{name:part.name})}
}

/** Validate/detach the result of ANY converter for a legacy tool with no native
 * output schema. An own output property, including output:undefined, would
 * violate the exact host runtime's "output in result" check and is refused. */
export function validateNativeLegacyResult(value,options={}){
  const mode=exposure(options),result=copy(value)
  if(!record(result))throw new TypeError('Native legacy result must be a record')
  keys(result,['content','metadata'],'Native legacy result')
  if(!Object.hasOwn(result,'content'))throw new TypeError('Native legacy result requires content')
  const content=typeof result.content==='string'?result.content:
    Array.isArray(result.content)&&result.content.length?result.content.map(p=>contentPart(p,mode)):undefined
  if(content===undefined)throw new TypeError('Native content must be text or a nonempty content array; use empty string to clear text')
  if(result.metadata!==undefined&&!record(result.metadata))throw new TypeError('Native metadata must be a plain record')
  // Preserve weak legacy observations across the final detached converter check.
  const metadata=result.metadata===undefined?undefined:durableLegacyMetadata(Object.getOwnPropertyDescriptor(value,'metadata').value)
  if(metadata&&Object.hasOwn(metadata,LEGACY_TITLE_METADATA_KEY)){
    const envelope=metadata[LEGACY_TITLE_METADATA_KEY]
    if(!record(envelope)||envelope.version!==1||typeof envelope.title!=='string')throw new TypeError('Invalid bridge title envelope')
    keys(envelope,['version','title'],'Bridge title envelope')
  }
  return {content,...(metadata===undefined?{}:{metadata})}
}

/** Field-preserving conversion of the preserved V1 SDK ToolResult union.
 * title is preserved using the Step 3 metadata convention, not a native UI API.
 * No result schema, remote access, retries or success/error heuristics. */
export function mapLegacyToolResult(value,options={}){
  const mode=exposure(options)
  if(typeof value==='string')return {content:value}
  const original=copy(value)
  if(!record(original))throw new TypeError('V1 result requires a string or an output record')
  keys(original,['title','output','metadata','attachments'],'V1 result')
  if(!Object.hasOwn(original,'output')||typeof original.output!=='string')throw new TypeError('V1 result record requires an output string')
  if(original.title!==undefined)text(original.title,'V1 title')
  if(original.metadata!==undefined&&!record(original.metadata))throw new TypeError('V1 metadata must be a plain record')
  const metadata=original.metadata===undefined?{}:original.metadata
  if(Object.hasOwn(metadata,LEGACY_TITLE_METADATA_KEY))throw new TypeError('V1 metadata collides with reserved bridge title envelope')
  if(original.title!==undefined)metadata[LEGACY_TITLE_METADATA_KEY]={version:1,title:original.title}
  if(original.attachments!==undefined&&!Array.isArray(original.attachments))throw new TypeError('V1 attachments must be an array')
  const files=(original.attachments??[]).map(a=>{
    if(!record(a))throw new TypeError('V1 attachment must be a record')
    keys(a,['type','mime','url','filename'],'V1 attachment')
    if(a.type!=='file')throw new TypeError('V1 attachment type must be file')
    return contentPart({type:'file',uri:a.url,mime:a.mime,...(a.filename===undefined?{}:{name:a.filename})},mode)
  })
  const result={content:files.length?[{type:'text',text:original.output},...files]:original.output,
    ...(original.metadata!==undefined||original.title!==undefined?{metadata}:{})}
  return validateNativeLegacyResult(result,{toolExposure:mode})
}
