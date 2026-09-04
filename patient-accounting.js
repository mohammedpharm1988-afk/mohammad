const express=require('express');
const {Pool}=require('pg');
const app=express();
app.use(express.json());
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:false});
const PORT=Number(process.env.PATIENT_PORT||3004);

async function init(){
  await pool.query(`create table if not exists patient_account_items(
    id bigserial primary key,
    patient_id bigint not null,
    category varchar(40) not null,
    ref_type varchar(60),
    ref_id bigint,
    ref_no varchar(100),
    description text,
    item_date timestamptz not null default now(),
    debit numeric(14,2) not null default 0,
    credit numeric(14,2) not null default 0,
    payment_method varchar(40),
    notes text,
    created_at timestamptz not null default now()
  )`);
  await pool.query(`create index if not exists idx_patient_account_items_patient_date on patient_account_items(patient_id,item_date,id)`);
  await pool.query(`create index if not exists idx_patient_account_items_category on patient_account_items(category)`);
  await installPharmacySync();
}

async function installPharmacySync(){
  await pool.query(`create or replace function sync_pharmacy_sale_to_patient_account() returns trigger language plpgsql as $$
  begin
    if NEW.patient_id is not null then
      insert into patient_account_items(patient_id,category,ref_type,ref_id,ref_no,description,item_date,debit,credit,payment_method,notes)
      values(NEW.patient_id,'pharmacy','pharmacy_sale',NEW.id,NEW.sale_no,'بيع صيدلية',coalesce(NEW.sale_date::timestamptz,now()),coalesce(NEW.total,0),coalesce(NEW.paid,0),null,'مزامنة تلقائية من مبيعات الصيدلية')
      on conflict do nothing;
    end if;
    return NEW;
  end $$`);
  await pool.query(`do $$ begin
    if to_regclass('public.pharmacy_sales') is not null then
      if not exists(select 1 from pg_trigger where tgname='trg_pharmacy_sale_patient_account') then
        create trigger trg_pharmacy_sale_patient_account after insert on pharmacy_sales for each row execute function sync_pharmacy_sale_to_patient_account();
      end if;
    end if;
  end $$`);
  if(await pool.query(`select to_regclass('public.pharmacy_sales') is not null as exists`).then(r=>r.rows[0].exists)){
    await pool.query(`insert into patient_account_items(patient_id,category,ref_type,ref_id,ref_no,description,item_date,debit,credit,notes)
      select s.patient_id,'pharmacy','pharmacy_sale',s.id,s.sale_no,'بيع صيدلية',coalesce(s.sale_date::timestamptz,now()),coalesce(s.total,0),coalesce(s.paid,0),'مزامنة للمبيعات السابقة'
      from pharmacy_sales s
      where s.patient_id is not null
        and not exists(select 1 from patient_account_items a where a.ref_type='pharmacy_sale' and a.ref_id=s.id and a.category='pharmacy')`);
  }
}

setInterval(()=>installPharmacySync().catch(e=>console.error('pharmacy sync:',e.message)),15000);

app.get('/health',async(q,s)=>{try{await init();s.json({ok:true,module:'patient-accounting',unified_ledger:true,pharmacy_auto_sync:true})}catch(e){s.status(500).json({ok:false,error:e.message})}});

const categories={pharmacy:'صيدلية',admission:'رقود/تنويم',file:'ملف',other:'خدمات أخرى'};
function validCategory(c){return Object.prototype.hasOwnProperty.call(categories,c)}

app.post('/api/patients/:patientId/account-items',async(req,res)=>{
  try{
    const patientId=Number(req.params.patientId); const {category,ref_type,ref_id,ref_no,description,item_date,debit=0,credit=0,payment_method,notes}=req.body||{};
    if(!Number.isInteger(patientId)||patientId<=0) return res.status(400).json({error:'patientId غير صحيح'});
    if(!validCategory(category)) return res.status(400).json({error:'category يجب أن تكون pharmacy أو admission أو file أو other'});
    if(Number(debit)<0||Number(credit)<0||(Number(debit)>0&&Number(credit)>0)) return res.status(400).json({error:'يجب إدخال مدين أو دائن فقط وبقيمة موجبة'});
    const r=await pool.query(`insert into patient_account_items(patient_id,category,ref_type,ref_id,ref_no,description,item_date,debit,credit,payment_method,notes) values($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz,now()),$8,$9,$10,$11) returning *`,[patientId,category,ref_type||null,ref_id?Number(ref_id):null,ref_no||null,description||categories[category],item_date||null,Number(debit)||0,Number(credit)||0,payment_method||null,notes||null]);
    res.status(201).json(r.rows[0]);
  }catch(e){res.status(500).json({error:e.message})}
});

app.get('/api/patients/:patientId/account-summary',async(req,res)=>{
  try{
    const id=Number(req.params.patientId);
    const r=await pool.query(`with x as (
      select 'استشارات' type,coalesce(sum(total),0) total,coalesce(sum(paid),0) paid from consultation_vouchers where patient_id=$1
      union all select 'مختبر',coalesce(sum(total),0),coalesce(sum(paid),0) from lab_orders where patient_id=$1
      union all select case category when 'pharmacy' then 'صيدلية' when 'admission' then 'رقود/تنويم' when 'file' then 'ملف' else 'خدمات أخرى' end,
        coalesce(sum(debit),0),coalesce(sum(credit),0) from patient_account_items where patient_id=$1 group by category
    ) select type,total,paid,total-paid balance from x`,[id]);
    const wanted=['استشارات','مختبر','صيدلية','رقود/تنويم','ملف','خدمات أخرى'];
    const map=new Map(r.rows.map(x=>[x.type,x]));
    const breakdown=wanted.map(type=>map.get(type)||{type,total:0,paid:0,balance:0});
    const t=breakdown.reduce((a,x)=>({total:a.total+Number(x.total),paid:a.paid+Number(x.paid),balance:a.balance+Number(x.balance)}),{total:0,paid:0,balance:0});
    res.json({patient_id:id,breakdown,grand_total:t.total,grand_paid:t.paid,grand_balance:t.balance});
  }catch(e){res.status(500).json({error:e.message})}
});

app.get('/api/patients/:patientId/account-statement',async(req,res)=>{
  try{
    const id=Number(req.params.patientId); await init(); const out=[];
    const c=await pool.query(`select created_at date,voucher_no ref,'استشارة' type,total debit,paid credit,balance from consultation_vouchers where patient_id=$1`,[id]);
    const l=await pool.query(`select created_at date,order_no ref,'مختبر' type,total debit,paid credit,balance from lab_orders where patient_id=$1`,[id]);
    const a=await pool.query(`select item_date date,coalesce(ref_no,ref_type) ref,case category when 'pharmacy' then 'صيدلية' when 'admission' then 'رقود/تنويم' when 'file' then 'ملف' else 'خدمات أخرى' end type,description,debit,credit,debit-credit balance from patient_account_items where patient_id=$1`,[id]);
    out.push(...c.rows,...l.rows,...a.rows); out.sort((x,y)=>new Date(x.date)-new Date(y.date));
    let running=0; for(const x of out){running+=Number(x.debit)-Number(x.credit);x.running_balance=Number(running.toFixed(2))}
    res.json({patient_id:id,rows:out,grand_total:Number(out.reduce((s,x)=>s+Number(x.debit),0).toFixed(2)),grand_paid:Number(out.reduce((s,x)=>s+Number(x.credit),0).toFixed(2)),grand_balance:Number(running.toFixed(2))});
  }catch(e){res.status(500).json({error:e.message})}
});

app.get('/api/patients/:patientId/account-items',async(req,res)=>{try{await init();const r=await pool.query(`select * from patient_account_items where patient_id=$1 order by item_date desc,id desc`,[Number(req.params.patientId)]);res.json(r.rows)}catch(e){res.status(500).json({error:e.message})}});

init().then(()=>app.listen(PORT,()=>console.log('Patient accounting module listening on '+PORT))).catch(e=>{console.error(e);process.exit(1)});