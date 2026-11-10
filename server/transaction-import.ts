import { readOfx } from './ofx-import.js';
export interface CsvMapping {
  dateColumn: number;
  nameColumn: number;
  amountColumn?: number;
  debitColumn?: number;
  creditColumn?: number;
  idColumn?: number;
  dateFormat: 'ymd' | 'mdy' | 'dmy';
  amountConvention: 'inflow-positive' | 'outflow-positive';
}
export interface ImportedTransaction {
  date: string;
  name: string;
  amount: number;
  iso_currency_code: string;
  sourceId?: string;
}
export interface ParsedImport {
  columns: string[];
  mapping: CsvMapping | null;
  transactions: ImportedTransaction[];
  errors: string[];
  total: number;
}
export function parseTransactionImport(fileName:string,content:string,currency:string,csv?:unknown,target?:{mask?:string|null}):ParsedImport {
 const result:ParsedImport={columns:[],mapping:null,transactions:[],errors:[],total:0};
 try {
  if(/\.(?:ofx|qfx)$/i.test(fileName))return readOfx(content,currency,target);
  if(!/\.csv$/i.test(fileName)) throw Error('Supported files: CSV, OFX and QFX.');
  const rows=readCsv(content.replace(/^\uFEFF/,''));
  result.columns=rows.shift() ?? [];result.total=rows.length;
  if(!rows.length) throw Error('File contains no transactions.');
  const headers=result.columns.map(h=>h.trim().toLowerCase());
  const find=(names:string[])=>{const n=headers.findIndex(h=>names.includes(h));return n<0?undefined:n;};
  if(csv!==undefined && (!csv || typeof csv!=='object' || Array.isArray(csv)))throw Error('Invalid CSV mapping.');
  const options=(csv ?? {}) as Partial<CsvMapping>;
  const explicit=Object.keys(options).some(k=>k.endsWith('Column'));
  const amount=find(['amount']);
  const idColumn=find(['id','transaction id','fitid']);
  const detected = {
    dateColumn: find(['date', 'transaction date', 'posted date']),
    nameColumn: find(['description', 'name', 'payee', 'memo']),
    ...(idColumn !== undefined ? { idColumn } : {}),
    ...(amount !== undefined ? { amountColumn: amount } : {
      debitColumn: find(['debit', 'withdrawal']), creditColumn: find(['credit', 'deposit']),
    }),
  };
  // Format-only options allow the UI to request autodetection before it knows columns.
  const mapping = {
    ...(explicit ? {} : detected), dateFormat: 'ymd', amountConvention: 'inflow-positive', ...options,
  } as CsvMapping;
  const indices = [
    mapping.dateColumn, mapping.nameColumn,
    ...(mapping.amountColumn !== undefined ? [mapping.amountColumn] : [mapping.debitColumn, mapping.creditColumn]),
    ...(mapping.idColumn !== undefined ? [mapping.idColumn] : []),
  ];
  const invalidIndex = indices.some(n => typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= headers.length);
  const mixedAmounts = mapping.amountColumn !== undefined && (mapping.debitColumn !== undefined || mapping.creditColumn !== undefined);
  if (invalidIndex || new Set(indices).size !== indices.length || mixedAmounts ||
    !['ymd', 'mdy', 'dmy'].includes(mapping.dateFormat) ||
    !['inflow-positive', 'outflow-positive'].includes(mapping.amountConvention)) {
    throw Error('Select valid distinct date, description and amount (or debit/credit) columns and formats.');
  }
  result.mapping=mapping;
  rows.forEach((row,index)=>{
   try {
    if(row.length!==headers.length)throw Error('Column count does not match header.');
    const date=calendarDate(row[mapping.dateColumn].trim(),mapping.dateFormat);
    const name = row[mapping.nameColumn].trim();
    if (!name) throw Error('Missing description.');
    let amount:number;
    if(mapping.amountColumn!==undefined)amount=money(row[mapping.amountColumn])*(mapping.amountConvention==='inflow-positive'?-1:1);
    else {
     const debit = row[mapping.debitColumn!].trim();
     const credit = row[mapping.creditColumn!].trim();
     if (!debit && !credit) throw Error('Missing debit/credit amount.');
     const d = debit ? money(debit) : 0;
     const c = credit ? money(credit) : 0;
     if (d < 0 || c < 0 || (d !== 0 && c !== 0)) {
       throw Error('Debit/credit must be nonnegative and only one may be nonzero.');
     }
     amount = d - c;
    }
    const sourceId = mapping.idColumn !== undefined ? row[mapping.idColumn].trim() : undefined;
    result.transactions.push({ date, name, amount: amount === 0 ? 0 : amount, iso_currency_code: currency, ...(sourceId ? { sourceId } : {}) });
   }catch(error){result.errors.push(`Row ${index+2}: ${error instanceof Error?error.message:'Invalid transaction.'}`);}
  });
 }catch(error){result.errors.push(error instanceof Error?error.message:'Invalid file.');}
 return result;
}
function calendarDate(raw:string,format:CsvMapping['dateFormat']):string {
 const match=raw.match(format==='ymd'?/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/:/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
 if(!match)throw Error('Invalid date.');
 const [a,b,c]=match.slice(1).map(Number);const [year,month,day]=format==='ymd'?[a,b,c]:format==='mdy'?[c,a,b]:[c,b,a];
 const date=`${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
 if(year<1000||month<1||month>12||day<1||day>31||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw Error('Invalid calendar date.');
 return date;
}
function money(raw:string):number {
 const value=raw.trim();
 if(!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value))throw Error('Invalid amount.');
 const number=Number(value.replace(/,/g,''));if(!Number.isFinite(number)||Math.abs(number)>Number.MAX_SAFE_INTEGER/100)throw Error('Amount outside supported range.');return number;
}
function readCsv(content: string): string[][] {
  const maxColumns = 100, maxCellLength = 16_384, maxTransactions = 50_000;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '', quoted = false, closed = false;
  for (let i = 0; i < content.length; i++) {
    if (field.length > maxCellLength) throw Error('CSV cell exceeds 16384 characters.');
    const c = content[i];
    if (quoted) {
      if (c === '"') {
        if (content[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += c;
      continue;
    }
    if (c === '"' && !field && !closed) { quoted = true; continue; }
    if (c === ',' || c === '\n' || c === '\r') {
      row.push(field);
      if (row.length > maxColumns || (c === ',' && row.length === maxColumns)) {
        throw Error('CSV exceeds 100 columns.');
      }
      field = '';
      closed = false;
      if (c !== ',') {
        // Ignore empty physical lines, not empty transaction records (",,").
        if (row.length > 1 || row.some(v => v.trim())) rows.push(row);
        if (rows.length > maxTransactions + 1) throw Error('CSV exceeds 50000 transactions.');
        row = [];
        if (c === '\r' && content[i + 1] === '\n') i++;
      }
      continue;
    }
    if (closed || c === '"') throw Error('Malformed CSV quoting.');
    field += c;
  }
  if (quoted) throw Error('Unterminated CSV quote.');
  if (field.length > maxCellLength) throw Error('CSV cell exceeds 16384 characters.');
  row.push(field);
  if (row.length > 1 || row.some(v => v.trim())) rows.push(row);
  if (rows.length > maxTransactions + 1) throw Error('CSV exceeds 50000 transactions.');
  return rows;
}
