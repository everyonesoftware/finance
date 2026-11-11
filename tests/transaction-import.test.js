import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTransactionImport as parse} from '../server/transaction-import.ts';
import { fidelityHeader, fidelityRows, fidelityFooter, fidelityHistory } from './fixtures/fidelity-history.js';
const map={dateColumn:0,nameColumn:1,amountColumn:2,dateFormat:'mdy',amountConvention:'outflow-positive'};
test('Fidelity history automatically maps cash activity and excludes its disclaimer from totals',()=>{
 for(const content of [fidelityHistory,fidelityHistory.replace(/\n/g,'\r\n')]) {
  const parsed=parse('history.csv',content,'USD');
  assert.deepEqual(parsed.errors,[]);
  assert.equal(parsed.total,fidelityRows.length);
  assert.equal(parsed.mapping.dateColumn,0);
  assert.equal(parsed.mapping.nameColumn,1);
  assert.equal(parsed.mapping.amountColumn,10);
  assert.equal(parsed.mapping.dateFormat,'mdy');
  assert.equal(parsed.transactions[0].date,'2026-10-30');
  assert.equal(parsed.transactions[0].name,'REINVESTMENT EXAMPLE FUND (DEMO) (Cash)');
  assert.deepEqual(parsed.transactions.map(t=>t.amount),[25,-25,-0.01,100,100,-200,30,-30]);
  assert.equal(parsed.transactions[5].date,'2026-10-26','Use run date, not settlement date');
  assert.match(parsed.notes.join(' '),/Fidelity.*cash activity/i);
  assert.match(parsed.notes.join(' '),/disclaimer.*ignored/i);
 }
});
test('Fidelity footer recognition works at end of file and never hides invalid transaction rows',()=>{
 const firstFooterLine=fidelityFooter.trim().split('\n')[0];
 const noNewline=parse('history.csv',fidelityHeader+'\n'+fidelityRows[0]+'\n'+firstFooterLine,'USD');
 assert.deepEqual(noNewline.errors,[]);
 assert.equal(noNewline.total,1);
 for(const badRow of [fidelityRows[0].replace('10/30/2026','02/30/2026'),fidelityRows[0].replace('"-25"','bad'),',,,,,,,,,,,,','not a transaction']) {
  const result=parse('history.csv',fidelityHeader+'\n'+fidelityRows[0]+'\n\n'+badRow+fidelityFooter,'USD');
  assert.ok(result.errors.length,badRow);
  assert.equal(result.total,2);
 }
 const generic=parse('other.csv','Date,Description,Amount\n2026-10-30,Shop,-25\n'+firstFooterLine+'\n','USD');
 assert.ok(generic.errors.length,'Generic CSV must not silently discard prose');
 const unknown=parse('history.csv',fidelityHeader+'\n'+fidelityRows[0]+'\nUnknown disclaimer\n','USD');
 assert.ok(unknown.errors.length,'Unknown Fidelity trailing rows must fail validation');
});
test('Fidelity mappings remain editable and quoted multiline actions are not mistaken for the footer',()=>{
 const explicit={dateColumn:12,nameColumn:3,amountColumn:10,dateFormat:'mdy',amountConvention:'outflow-positive'};
 const mapped=parse('history.csv',fidelityHeader+'\n'+fidelityRows[5]+fidelityFooter,'USD',explicit);
 assert.deepEqual(mapped.errors,[]);
 assert.equal(mapped.transactions[0].name,'EXAMPLE FUND');
 assert.equal(mapped.transactions[0].date,'2026-10-27');
 assert.equal(mapped.transactions[0].amount,200);
 const action='Action, "quoted"\n'+fidelityFooter.trim().split('\n')[0];
 const row=fidelityRows[0].replace('REINVESTMENT EXAMPLE FUND (DEMO) (Cash)','"'+action.replace(/"/g,'""')+'"');
 const multiline=parse('history.csv',fidelityHeader+'\n'+row+fidelityFooter,'USD');
 assert.deepEqual(multiline.errors,[]);
 assert.equal(multiline.transactions[0].name,action);
 const columns=fidelityHeader.split(',').reverse().join(',');
 const reordered=parse('history.csv',columns+'\n'+fidelityRows[0].split(',').reverse().join(',')+fidelityFooter,'USD');
 assert.deepEqual(reordered.errors,[]);
 assert.deepEqual(reordered.transactions,parse('history.csv',fidelityHeader+'\n'+fidelityRows[0],'USD').transactions);
});
test('OFX account validation ignores transaction-level destination and source references',()=>{
 for(const xml of [false,true]) {
  for(const creditCard of [false,true]) {
   const field=(tag,value)=>`<${tag}>${value}${xml?`</${tag}>`:''}`;
   const statementTag=creditCard?'CCSTMTRS':'STMTRS';
   const accountTag=creditCard?'CCACCTFROM':'BANKACCTFROM';
   const referenceTag=creditCard?'CCACCTTO':'BANKACCTTO';
   const transaction=(id,amount,reference)=>'<STMTTRN>'+field('DTPOSTED','20261101')+field('TRNAMT',amount)+field('NAME','Example purchase')+field('FITID',id)+`<${referenceTag}>`+field('ACCTID',reference)+`</${referenceTag}>`+'</STMTTRN>';
   const statement=`<${statementTag}>`+field('CURDEF','USD')+`<${accountTag}>`+field('ACCTID','99991234')+`</${accountTag}><BANKTRANLIST>`+transaction('purchase','-8.42','5678')+transaction('refund','14.05','1234')+'</BANKTRANLIST>'+`</${statementTag}>`;
   const wrap=body=>(xml?'<?xml version="1.0"?>':'OFXHEADER:100\nVERSION:102\n\n')+'<OFX>'+body+'</OFX>';
   const parsed=parse('statement.qfx',wrap(statement),'USD',undefined,{mask:'1234'});
   assert.deepEqual(parsed.errors,[]);
   assert.equal(parsed.total,2);
   assert.deepEqual(parsed.transactions.map(t=>[t.sourceId,t.amount]),[['purchase',8.42],['refund',-14.05]]);
   assert.match(parse('statement.qfx',wrap(statement),'USD',undefined,{mask:'5678'}).errors.join(' '),/account mask/);
   assert.match(parse('statement.qfx',wrap(statement+statement),'USD').errors.join(' '),/one account statement/);
   const withSource=statement.replace(`</${referenceTag}>`,`</${referenceTag}><${accountTag}>`+field('ACCTID','8765')+`</${accountTag}>`);
   assert.deepEqual(parse('statement.qfx',wrap(withSource),'USD',undefined,{mask:'1234'}).errors,[]);
  }
 }
});
test('QFX dotted metadata tags preserve transactions in SGML and XML statements',()=>{
 for(const xml of [false,true]) {
  const field=(tag,value)=>`<${tag}>${value}${xml?`</${tag}>`:''}`;
  const metadata='<SIGNONMSGSRSV1><SONRS>'+field('INTU.BID','1234')+'</SONRS></SIGNONMSGSRSV1>';
  const statement='<STMTRS>'+field('CURDEF','USD')+'<BANKTRANLIST><STMTTRN>'+field('DTPOSTED','20261101')+field('TRNAMT','-25.50')+field('NAME','Example transfer')+field('FITID','example-reference')+'</STMTTRN></BANKTRANLIST></STMTRS>';
  const content=(xml?'<?xml version="1.0"?>':'OFXHEADER:100\nVERSION:102\n\n')+'<OFX>'+metadata+statement+'</OFX>';
  const parsed=parse('statement.qfx',content,'USD');
  assert.deepEqual(parsed.errors,[]);
  assert.equal(parsed.total,1);
  assert.deepEqual(parsed.transactions,[{date:'2026-11-01',name:'Example transfer',amount:25.5,iso_currency_code:'USD',sourceId:'example-reference'}]);
  if(xml) {
   for(const invalid of [content.replace('</INTU.BID>','</INTU.OTHER>'),content.replace('</INTU.BID>',''),content.replace('INTU.BID','INTU@BID')]) {
    assert.ok(parse('statement.qfx',invalid,'USD').errors.length);
   }
  }
 }
});
test('OFX comments cannot introduce transactions or truncate descriptions', () => {
 const real='<STMTTRN><DTPOSTED>20261101</DTPOSTED><TRNAMT>-5</TRNAMT><NAME>Coffee<!-- note --> shop</NAME><FITID>real</FITID></STMTTRN>';
 const ignored='<STMTTRN><DTPOSTED>20261102</DTPOSTED><TRNAMT>-999</TRNAMT><NAME>Not a transaction</NAME><FITID>commented</FITID></STMTTRN>';
 const parsed=parse('x.ofx','<?xml version="1.0"?><OFX><STMTRS><CURDEF>USD</CURDEF><BANKTRANLIST>'+real+'<!--'+ignored+'--></BANKTRANLIST></STMTRS></OFX>','USD');
 assert.deepEqual(parsed.errors,[]);
 assert.equal(parsed.total,1);
 assert.equal(parsed.transactions.length,1);
 assert.equal(parsed.transactions[0].name,'Coffee shop');
});
test('OFX and QFX SGML/XML preserve FITID, full transfer descriptions and canonical signs',()=>{
 const sgml='OFXHEADER:100\r\nVERSION:102\r\n\r\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><ACCTID>99991234</BANKACCTFROM><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261101120000[-5:EST]<TRNAMT>-25.50<FITID>private-reference<NAME>Transfer &amp; savings<MEMO>full descriptor 4321</STMTTRN><STMTTRN><DTPOSTED>20261102<TRNAMT>10<NAME>Refund</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';
 const parsed=parse('bank.QFX',sgml,'USD',undefined,{mask:'1234'});
 assert.deepEqual(parsed.errors,[]);assert.equal(parsed.total,2);assert.deepEqual(parsed.transactions.map(t=>t.amount),[25.5,-10]);assert.equal(parsed.transactions[0].name,'Transfer & savings full descriptor 4321');assert.equal(parsed.transactions[0].sourceId,'private-reference');assert.equal(parsed.transactions[0].date,'2026-11-01');
 const xml='<?xml version="1.0"?><OFX><STMTRS><CURDEF>USD</CURDEF><BANKTRANLIST><STMTTRN><DTPOSTED>20240229</DTPOSTED><TRNAMT>-1.00</TRNAMT><NAME>Shop &#38; Cafe</NAME><FITID>xml-id</FITID></STMTTRN></BANKTRANLIST></STMTRS></OFX>';
 assert.deepEqual(parse('bank.ofx',xml,'USD').errors,[]);assert.equal(parse('bank.ofx',xml,'USD').transactions[0].name,'Shop & Cafe');
 for(const content of [sgml.replace('USD','EUR'),sgml.replace('99991234','99995678'),sgml.replace('20261102','20260230'),sgml.replace('<TRNAMT>10','<TRNAMT>10bad'),xml.replace('<OFX>','<!DOCTYPE OFX [<!ENTITY x "secret">]><OFX>'),xml.replace('<OFX>','<!ENTITY x "secret"><OFX>'),xml.replace('</STMTTRN>',''),'<OFX></OFX>'])assert.ok(parse('bank.ofx',content,'USD',undefined,{mask:'1234'}).errors.length,content);
 assert.ok(parse('bank.txt',sgml,'USD').errors.length);
});
test('OFX corrections reject the whole XML or SGML file before accepting any transactions',()=>{
 for(const xml of [false,true]) {
  const field=(tag,value)=>`<${tag}>${value}${xml?`</${tag}>`:''}`;
  const transaction=(id,amount,correction='')=>'<STMTTRN>'+field('DTPOSTED','20261101')+field('TRNAMT',amount)+field('NAME','Shop')+field('FITID',id)+correction+'</STMTTRN>';
  const original=transaction('original','-25');
  const wrap=rows=>(xml?'<?xml version="1.0"?>':'OFXHEADER:100\nVERSION:102\n\n')+'<OFX><STMTRS>'+field('CURDEF','USD')+'<BANKTRANLIST>'+rows+'</BANKTRANLIST></STMTRS></OFX>';
  assert.deepEqual(parse('x.ofx',wrap(original),'USD').errors,[]);
  for(const correction of [field('CORRECTFITID','original'),field('correctaction','REPLACE'),field('CoRrEcTaCtIoN','DELETE'),field('correctfitid','original')+field('CORRECTACTION','REPLACE'),field('CORRECTFITID','original')+field('correctaction','DELETE')]) {
   const parsed=parse('x.ofx',wrap(original+transaction('replacement','-20',correction)),'USD');
   assert.match(parsed.errors.join(' '),/correction.*unsupported/i,`${xml?'XML':'SGML'} ${correction}`);
   assert.deepEqual(parsed.transactions,[],'No original or replacement rows may escape whole-file rejection');
  }
 }
});
test('OFX rejects unsupported investment records, multi-statements, foreign currencies and oversized fields',()=>{
 const statement='<STMTRS><CURDEF>USD<BANKTRANLIST><STMTTRN><DTPOSTED>20261101<TRNAMT>-1<NAME>Shop</STMTTRN></BANKTRANLIST></STMTRS>';
 for(const content of ['<OFX>'+statement+'<INVSTMTRS><INVTRANLIST><BUYMF></BUYMF></INVTRANLIST></INVSTMTRS></OFX>','<OFX>'+statement+statement+'</OFX>','<OFX>'+statement.replace('</STMTTRN>','<CURRENCY><CURSYM>EUR</CURRENCY></STMTTRN>')+'</OFX>','<OFX>'+statement.replace('Shop','x'.repeat(16385))+'</OFX>'])assert.ok(parse('x.ofx',content,'USD').errors.length);
 const emptyName='<OFX>'+statement.replace('<NAME>Shop','<NAME><MEMO>Full transfer descriptor')+'</OFX>';
 const valid=parse('x.ofx',emptyName,'USD');assert.deepEqual(valid.errors,[]);assert.equal(valid.transactions[0].name,'Full transfer descriptor');
});
test('CSV column, cell and transaction counts are bounded before exposing mappings',()=>{
 for(const content of [','.repeat(2000000),Array.from({length:101},(_,i)=>'Column'+i).join(',')+'\na,b,c','Date,Description,Amount\n2026-01-01,'+'x'.repeat(16385)+',1','Date,Description,Amount\n'+('2026-01-01,Shop,1\n'.repeat(50001))]) {
 const result=parse('large.csv',content,'USD');assert.ok(result.errors.length);assert.equal(result.mapping,null);assert.ok(result.columns.length<=100);
 }
 const permitted=parse('x.csv','Date,Description,Amount\n2026-01-01,'+'x'.repeat(16384)+',1','USD');assert.deepEqual(permitted.errors,[]);
});
test('malformed XML and empty CSV transaction rows fail validation rather than being accepted',()=>{
 const xml='<?xml version="1.0"?><OFX><STMTRS><CURDEF>USD</CURDEF><BANKTRANLIST><STMTTRN><DTPOSTED>20261101</DTPOSTED><TRNAMT>-1.00</TRNAMT><NAME>Shop</NAME></STMTTRN></BANKTRANLIST></STMTRS></OFX>';
 for(const invalid of [xml.replace('</TRNAMT>',''),xml.replace('</STMTRS>',''),xml.replace('</NAME>','</MEMO>'),xml.replace('Shop','&unknown;'),xml+'<STMTTRN>',xml.replace('<STMTTRN>','<STMTTRN><UNEXPECTED>')])assert.ok(parse('x.ofx',invalid,'USD').errors.length,invalid);
 assert.ok(parse('x.csv','Date,Description,Amount\n2026-01-01,Good,1\n,,','USD').errors.length);
});
test('CSV explicit mappings validate calendar dates, strict money and multiline quoted descriptions',()=>{
 const partial=parse('x.csv','Date,Description,Amount\n12/31/2026,Income,3','USD',{dateFormat:'mdy',amountConvention:'outflow-positive'});
 assert.deepEqual(partial.errors,[]);assert.equal(partial.mapping.amountColumn,2);assert.equal(partial.transactions[0].date,'2026-12-31');assert.equal(partial.transactions[0].amount,3);
 const valid=parse('file.csv','\uFEFFWhen,Who,Value,Reference\r\n02/29/2024,"Transfer ""quoted""\r\nfull description","1,234.50",secret-id','USD',{...map,idColumn:3});
 assert.deepEqual(valid.errors,[]);assert.equal(valid.transactions[0].date,'2024-02-29');assert.equal(valid.transactions[0].name,'Transfer "quoted"\r\nfull description');assert.equal(valid.transactions[0].amount,1234.5);assert.equal(valid.transactions[0].sourceId,'secret-id');
 for(const [date,amount] of [['02/29/2025','5'],['04/31/2026','5'],['13/01/2026','5'],['01/01/2026','5oops'],['01/01/2026','1e3'],['01/01/2026','1.234'],['01/01/2026','NaN'],['01/01/2026','12,34']]) assert.ok(parse('x.csv',`When,Who,Value\n${date},Shop,"${amount}"`,'USD',map).errors.length, date+' '+amount);
 const split=parse('x.csv','Date,Description,Debit,Credit\n31/12/2026,Shop,12.00,\n30/12/2026,Refund,,3.50','USD',{dateColumn:0,nameColumn:1,debitColumn:2,creditColumn:3,dateFormat:'dmy',amountConvention:'inflow-positive'});
 assert.deepEqual(split.errors,[]);assert.deepEqual(split.transactions.map(t=>t.amount),[12,-3.5]);
});
test('unknown or invalid CSV mapping returns columns and errors, never silently skips malformed rows',()=>{
 for(const mapping of [undefined,{...map,dateColumn:-1},{...map,dateColumn:1.5},{...map,amountColumn:9},{...map,dateFormat:'guess'},{...map,amountConvention:'guess'},{...map,debitColumn:2,creditColumn:2}]) {
 const result=parse('x.csv','When,Who,Value\n2026-01-01,Shop,5','USD',mapping);assert.deepEqual(result.columns,['When','Who','Value']);assert.equal(result.mapping,null);assert.ok(result.errors.length);
 }
 for(const content of ['', 'Date,Description,Amount', 'Date,Description,Amount\n2026-01-01,"bad,5', 'Date,Description,Amount\n2026-01-01,Shop,5,extra']) assert.ok(parse('x.csv',content,'USD').errors.length);
});
