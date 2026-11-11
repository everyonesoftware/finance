import type { ParsedImport } from './transaction-import.js';
export function readOfx(content:string,currency:string,target?:{mask?:string|null}):ParsedImport {
 const result:ParsedImport={columns:[],mapping:null,transactions:[],errors:[],total:0};
 try {
  // Parse the same comment-free content that structural validation sees.
  content = content.replace(/<!--[\s\S]*?-->/g, '');
  if(/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(content))throw Error('DTD and entity declarations are forbidden.');
  if(!/<OFX\s*>/i.test(content)||!/<\/OFX\s*>/i.test(content))throw Error('Invalid OFX document.');
  if (/<(?:CORRECTFITID|CORRECTACTION)\b/i.test(content)) {
    throw Error('OFX correction instructions are unsupported; import an uncorrected statement instead.');
  }
  validateStructure(content);
  if (/<(?:INVSTMTRS|INVTRANLIST|INVTRAN)\b/i.test(content)) {
    throw Error('Investment trade records are unsupported; import cash transactions as CSV.');
  }
  if ((content.match(/<(?:STMTRS|CCSTMTRS)\s*>/gi) ?? []).length > 1) {
    throw Error('Import one account statement at a time.');
  }
  const field=(text:string,tag:string):string|undefined=>{
   const values=[...text.matchAll(new RegExp(`<${tag}\\s*>([^<]*)`,'gi'))];
   if(values.length>1)throw Error(`Duplicate OFX ${tag} field.`);
   if (values[0]?.[1].length > 16_384) throw Error('OFX field exceeds 16384 characters.');
   return values[0]?decodeOfx(values[0][1].trim()):undefined;
  };
  const currencies=[...content.matchAll(/<(?:CURDEF|CURSYM)\s*>([^<]*)/gi)].map(m=>m[1].trim());
  if(currencies.some(c=>c!==currency))throw Error('Statement currency does not match the account.');
  const accountIds=[...content.matchAll(/<ACCTID\s*>([^<]*)/gi)].map(m=>decodeOfx(m[1].trim()));
  if(new Set(accountIds).size>1)throw Error('Import one account statement at a time.');
  if(target?.mask && accountIds.some(id=>!id.endsWith(target.mask!)))throw Error('Statement account does not match the account mask.');
  const blocks=[...content.matchAll(/<STMTTRN\s*>([\s\S]*?)<\/STMTTRN\s*>/gi)];
  result.total=(content.match(/<STMTTRN\s*>/gi)??[]).length;
  if(!result.total)throw Error('File contains no transactions.');
  if(blocks.length!==result.total)throw Error('Malformed OFX transaction boundaries.');
  for(const [index,block] of blocks.entries()){
   try {
    if(/<STMTTRN\s*>/i.test(block[1]))throw Error('Malformed OFX transaction.');
    const posted=field(block[1],'DTPOSTED')??'';
    if(!/^\d{8}(?:\d{6}(?:\.\d{1,3})?(?:\[[+-]?\d+(?:\.\d+)?:[A-Za-z]+\])?)?$/.test(posted))throw Error('Invalid OFX date.');
    const date=`${posted.slice(0,4)}-${posted.slice(4,6)}-${posted.slice(6,8)}`;
    if(Number(posted.slice(0,4))<1000||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw Error('Invalid calendar date.');
    const raw=field(block[1],'TRNAMT')??'';
    if(!/^[+-]?\d+(?:\.\d{1,2})?$/.test(raw))throw Error('Invalid amount.');
    const amount=-Number(raw);
    if(!Number.isFinite(amount)||Math.abs(amount)>Number.MAX_SAFE_INTEGER/100)throw Error('Amount outside supported range.');
    const name=[field(block[1],'NAME'),field(block[1],'MEMO')].filter(Boolean).join(' ');
    if(!name)throw Error('Missing description.');
    if(name.length>16_384)throw Error('OFX description exceeds 16384 characters.');
    const sourceId=field(block[1],'FITID');
    result.transactions.push({date,name,amount:amount===0?0:amount,iso_currency_code:currency,...(sourceId?{sourceId}:{})});
   }catch(error){result.errors.push(`Transaction ${index+1}: ${(error as Error).message}`);}
  }
 }catch(error){result.errors.push((error as Error).message);}
 return result;
}
function validateStructure(content:string):void {
 const xml=/<\?xml\b|VERSION\s*:\s*2\d\d/i.test(content) || /<\/DTPOSTED\s*>/i.test(content);
 const start=content.search(/<OFX\s*>/i);
 const body=content.slice(start).replace(/<!--[\s\S]*?-->/g,'');
 const stack:Array<{tag:string;leaf:boolean}>=[];
 let end=0,finished=false;
 // QFX metadata includes dotted tag names such as INTU.BID.
 const tags=/<(\/?)([A-Za-z][A-Za-z0-9_.]*)(\s*\/?)>/g;
 for(const match of body.matchAll(tags)){
  const between=body.slice(end,match.index);
  if(between.includes('<') || (finished && between.trim()))throw Error('Malformed OFX markup.');
  if(xml && /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(between))throw Error('Unknown XML entity.');
  const closing=match[1]==='/',tag=match[2].toUpperCase();
  if(finished)throw Error('Unexpected content after OFX root.');
  if(!xml && stack.at(-1)?.leaf && (!closing || stack.at(-1)?.tag!==tag))stack.pop();
  if(closing){if(stack.pop()?.tag!==tag)throw Error('Mismatched OFX closing tag.');if(!stack.length)finished=true;}
  else if(!match[3].includes('/')){
   const tail=body.slice(match.index!+match[0].length);const text=tail.slice(0,tail.indexOf('<')<0?tail.length:tail.indexOf('<'));
   stack.push({tag,leaf:!!text.trim() || ['NAME','MEMO','FITID','CHECKNUM','TRNTYPE','DTPOSTED','TRNAMT'].includes(tag)});
  }
  end=match.index!+match[0].length;
 }
 if(stack.length||!finished||body.slice(end).trim())throw Error('Incomplete OFX markup.');
}
function decodeOfx(value:string):string {
 return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_all,entity:string)=>{
  const known:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
  if(entity[0]!=='#')return known[entity.toLowerCase()];
  const code=entity[1].toLowerCase()==='x'?Number.parseInt(entity.slice(2),16):Number(entity.slice(1));
  if(code<=0||code>0x10ffff||(code>=0xd800&&code<=0xdfff))throw Error('Invalid character reference.');return String.fromCodePoint(code);
 });
}
