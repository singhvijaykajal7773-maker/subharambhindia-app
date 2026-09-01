const XLSX = require('xlsx');

// Exact headers from the supplied 28-column master sheet. Keep these names stable so
// decorative/Unicode Excel headers do not break imports.
const COLUMNS = [
  'Exp/Active','Renuwal Time','NAME','—͟͞͞★𝔻ate ǿf 𝕭irth—͟͞͞★','＊*•̩̩͙✩•̩̩͙*Salon Names𒆜*•̩̩͙✩•̩̩͙*',
  '☎♦⪼Contact 1⪻♦','☎♦⪼Contact 2⪻♦','ID Number','Joining Date','~۶Û۶~','Paym.','Payment Code','Payment Status',
  'Catgory(Salon name)','City','Reference','Close by','Service Manager','Address','Pin Code','Area','Email addresss','EXP.',
  "GRAPHIC'S",'REEL DONE','logo','visiting card','Insta id'
];
const KEY = {
  status:'Exp/Active', renewalTime:'Renuwal Time', name:'NAME', dob:COLUMNS[3], salonName:COLUMNS[4], phone:COLUMNS[5], phone2:COLUMNS[6],
  memberId:'ID Number', joiningDate:'Joining Date', internalCode:'~۶Û۶~', payment:'Paym.', paymentCode:'Payment Code', paymentStatus:'Payment Status',
  category:'Catgory(Salon name)', city:'City', reference:'Reference', closeBy:'Close by', serviceManager:'Service Manager', address:'Address',
  pinCode:'Pin Code', area:'Area', email:'Email addresss', experience:'EXP.', graphics:"GRAPHIC'S", reelDone:'REEL DONE', logo:'logo', visitingCard:'visiting card', instagram:'Insta id'
};
function norm(v){ return String(v ?? '').trim(); }
function excelValue(v){
  if (v instanceof Date) return v.toISOString().slice(0,10);
  return v == null ? '' : v;
}
function normalizePhone(value){
  let p = norm(value).replace(/[^0-9+]/g,'');
  if (p.startsWith('+91')) p=p.slice(3); else if(p.startsWith('91')&&p.length===12)p=p.slice(2);
  if(p.length===10)return '+91'+p;
  return p.startsWith('+')?p:(p?'+'+p:'');
}
function mapRow(row){
  const raw={};
  for(const col of COLUMNS) raw[col]=excelValue(row[col]);
  const c={
    name:norm(raw[KEY.name]), phone:normalizePhone(raw[KEY.phone]), phone2:normalizePhone(raw[KEY.phone2]),
    memberId:norm(raw[KEY.memberId]), status:norm(raw[KEY.status]).toLowerCase(), renewalTime:raw[KEY.renewalTime] ?? '',
    dob:raw[KEY.dob]||'', salonName:norm(raw[KEY.salonName]), joiningDate:raw[KEY.joiningDate]||'', internalCode:norm(raw[KEY.internalCode]),
    payment:raw[KEY.payment]??'', paymentCode:norm(raw[KEY.paymentCode]), paymentStatus:norm(raw[KEY.paymentStatus]), category:norm(raw[KEY.category]),
    city:norm(raw[KEY.city]), reference:norm(raw[KEY.reference]), closeBy:norm(raw[KEY.closeBy]), serviceManager:norm(raw[KEY.serviceManager]),
    address:norm(raw[KEY.address]), pinCode:norm(raw[KEY.pinCode]), area:norm(raw[KEY.area]), email:norm(raw[KEY.email]), experience:norm(raw[KEY.experience]),
    graphics:raw[KEY.graphics]??'', reelDone:raw[KEY.reelDone]??'', logo:norm(raw[KEY.logo]), visitingCard:norm(raw[KEY.visitingCard]), instagram:norm(raw[KEY.instagram]),
    // expiryDate is deliberately NOT inferred from the sheet's ambiguous EXP./renewal columns.
    // Owner can set the exact date in the Admin Panel.
    expiryDate:null,
    rawData:raw
  };
  return c;
}
function readWorkbook(filePath){
  const wb=XLSX.readFile(filePath,{cellDates:true});
  const sheetName=wb.SheetNames[0];
  const sheet=wb.Sheets[sheetName];
  const rows=XLSX.utils.sheet_to_json(sheet,{defval:'',raw:true});
  return {sheetName,rows:rows.map(mapRow)};
}
module.exports={COLUMNS,KEY,mapRow,readWorkbook,normalizePhone};
