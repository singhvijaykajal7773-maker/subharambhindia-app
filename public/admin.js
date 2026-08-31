const TOKEN=localStorage.getItem('sai_token');
const $=s=>document.querySelector(s);
const $$=s=>document.querySelectorAll(s);
if(!TOKEN){location.href='./';}
function api(path,opt={}){const h=opt.headers||{};h.Authorization=`Bearer ${TOKEN}`;if(!(opt.body instanceof FormData))h['Content-Type']='application/json';return fetch(`/api${path}`,{...opt,headers:h}).then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'Request failed');return d})}
function notice(msg,error=false){const n=$('#notice');n.textContent=msg;n.className='notice'+(error?' error':'');setTimeout(()=>n.classList.add('hidden'),4000)}
const titles={dashboard:['Dashboard','Business overview and system health'],members:['Members','Excel customer database and membership status'],campaigns:['Campaigns','In-app business broadcast and campaign history'],ai:['AI Calling','Scripts, consent-ready queue and call jobs'],users:['Users & Roles','Owner-controlled access management'],activity:['Activity','Recent owner activity']};
function showSection(id){$$('.section').forEach(x=>x.classList.toggle('active',x.id===id));$$('.nav').forEach(x=>x.classList.toggle('active',x.dataset.section===id));$('#section-title').textContent=titles[id][0];$('#section-sub').textContent=titles[id][1]; if(id==='dashboard')loadDashboard();if(id==='members')loadMembers();if(id==='campaigns')loadCampaigns();if(id==='ai')loadAI();if(id==='users')loadUsers();if(id==='activity')loadActivity();}
$$('.nav').forEach(b=>b.onclick=()=>showSection(b.dataset.section));$$('[data-go]').forEach(b=>b.onclick=()=>showSection(b.dataset.go));$('#logout').onclick=()=>{localStorage.removeItem('sai_token');location.href='./'};
async function loadDashboard(){try{const d=await api('/owner/overview');$('#stats').innerHTML=Object.entries({Members:d.counts.total,Valid:d.counts.valid,Expired:d.counts.expired,'New':d.counts.new,'AI Queue':d.jobs.queued}).map(([k,v])=>`<div class="stat"><span>${k}</span><strong>${v}</strong></div>`).join('');$('#health').innerHTML='<span class="badge valid">API ONLINE</span> &nbsp; Demo mode supported';}catch(e){notice(e.message,true)}}
function badge(s){return `<span class="badge ${s}">${s.toUpperCase()}</span>`}
async function loadMembers(){try{const q=encodeURIComponent($('#member-search').value||'');const st=$('#member-status').value;const d=await api(`/owner/contacts?q=${q}&status=${st}`);window.__members=d.contacts;renderMembersTable(d.contacts)}catch(e){notice(e.message,true)}}
function renderMembersTable(contacts,editingId){
  $('#member-table').innerHTML=`<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Expiry</th><th>Group</th><th>AI Call OK</th><th>Action</th></tr></thead><tbody>${contacts.map(c=>{
    if(c.id===editingId){
      return `<tr><td><input class="edit-name" value="${esc(c.name)}" style="width:110px"></td><td><input class="edit-phone" value="${esc(c.phone)}" style="width:120px"></td><td><select class="edit-status"><option value="valid" ${c.computedStatus==='valid'?'selected':''}>Valid</option><option value="expired" ${c.computedStatus==='expired'?'selected':''}>Expired</option><option value="new" ${c.computedStatus==='new'?'selected':''}>New</option><option value="expiring_soon" ${c.computedStatus==='expiring_soon'?'selected':''}>Expiring Soon</option></select></td><td><input class="edit-expiry" type="date" value="${esc((c.expiryDate||'').slice(0,10))}"></td><td><input class="edit-group" value="${esc(c.group||'')}" style="width:90px"></td><td><input class="edit-consent" type="checkbox" ${c.callingConsent?'checked':''}></td><td style="white-space:nowrap"><button class="btn primary save-member" data-id="${c.id}">Save</button> <button class="btn ghost cancel-member">Cancel</button></td></tr>`;
    }
    return `<tr><td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td>${badge(c.computedStatus)}</td><td>${esc((c.expiryDate||'-'))}</td><td>${esc(c.group||'-')}</td><td>${c.callingConsent?'Yes':'No'}</td><td><button class="btn ghost edit-member" data-id="${c.id}">Edit</button></td></tr>`;
  }).join('')||'<tr><td colspan="7" class="muted">No members found</td></tr>'}</tbody></table></div>`;
  $$('.edit-member').forEach(btn=>btn.onclick=()=>renderMembersTable(window.__members,btn.dataset.id));
  $$('.cancel-member').forEach(btn=>btn.onclick=()=>renderMembersTable(window.__members));
  $$('.save-member').forEach(btn=>btn.onclick=async()=>{
    const row=btn.closest('tr');
    const body=JSON.stringify({name:row.querySelector('.edit-name').value,phone:row.querySelector('.edit-phone').value,status:row.querySelector('.edit-status').value,expiryDate:row.querySelector('.edit-expiry').value,group:row.querySelector('.edit-group').value,callingConsent:row.querySelector('.edit-consent').checked});
    btn.disabled=true;btn.textContent='Saving...';
    try{await api(`/owner/contacts/${btn.dataset.id}`,{method:'PATCH',body});notice('Member updated');loadMembers()}catch(e){notice(e.message,true);btn.disabled=false;btn.textContent='Save'}
  });
}
$('#member-search').oninput=loadMembers;$('#member-status').onchange=loadMembers;
$('#excel').onchange=async e=>{const f=e.target.files[0];if(!f)return;const fd=new FormData();fd.append('file',f);try{const d=await api('/owner/import-xlsx',{method:'POST',body:fd});notice(`Imported: ${d.added} added, ${d.updated} updated, ${d.skipped} skipped`);loadMembers();loadDashboard()}catch(err){notice(err.message,true)}e.target.value=''};
async function loadCampaigns(){try{const d=await api('/marketing/campaigns');$('#campaign-table').innerHTML=`<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Audience</th><th>Status</th><th>Total</th><th>Sent</th><th>Action</th></tr></thead><tbody>${d.campaigns.map(c=>`<tr><td>${esc(c.name)}</td><td>${esc(c.group)}</td><td>${esc(c.status)}</td><td>${c.stats.total}</td><td>${c.stats.sent}</td><td>${c.status==='draft'?`<button class="btn" onclick="sendCamp('${c.id}')">Send In-App</button>`:''}</td></tr>`).join('')||'<tr><td colspan="6" class="muted">No campaigns yet</td></tr>'}</tbody></table></div>`}catch(e){notice(e.message,true)}}
window.sendCamp=async id=>{try{const d=await api(`/marketing/campaigns/${id}/send-internal`,{method:'POST',body:'{}'});notice(`Sent to ${d.result.sent} app users; skipped ${d.result.skipped}`);loadCampaigns()}catch(e){notice(e.message,true)}};
$('#create-camp').onclick=async()=>{try{const d=await api('/marketing/campaigns',{method:'POST',body:JSON.stringify({name:$('#camp-name').value,message:$('#camp-message').value,group:$('#camp-group').value})});notice(`Campaign created: ${d.campaign.name}`);$('#camp-name').value='';$('#camp-message').value='';loadCampaigns()}catch(e){notice(e.message,true)}};
async function loadAI(){
  try{
    const [s,j,c]=await Promise.all([api('/owner/scripts'),api('/owner/ai-calls/jobs'),api('/owner/ai-calls/campaigns')]);
    window.__scripts=s.scripts;
    const sel=$('#ai-campaign-script');
    const current=sel.value;
    sel.innerHTML='<option value="">Select saved script</option>'+s.scripts.filter(x=>x.enabled).map(x=>`<option value="${esc(x.id)}">${esc(x.name)} — ${esc(x.matchStatus)}</option>`).join('');
    if(current)sel.value=current;
    $('#ai-table').innerHTML=`<div class="table-wrap"><table class="table"><thead><tr><th>Script</th><th>Match</th><th>Enabled</th><th>Agent ID</th><th>Action</th></tr></thead><tbody>${s.scripts.map(x=>`<tr><td>${esc(x.name)}</td><td>${badge(x.matchStatus)}</td><td>${x.enabled?'Yes':'No'}</td><td>${x.bolnaAgentId?esc(x.bolnaAgentId):'<span class="muted">Default / Not set</span>'}</td><td><button class="btn ghost edit-script" data-id="${x.id}">Edit</button></td></tr>`).join('')||'<tr><td colspan="5" class="muted">No scripts yet</td></tr>'}</tbody></table></div>`;
    $$('.edit-script').forEach(btn=>btn.onclick=()=>{const sc=window.__scripts.find(x=>x.id===btn.dataset.id);if(!sc)return;$('#script-name').value=sc.name;$('#script-status').value=sc.matchStatus;$('#script-text').value=sc.script;$('#script-agent-id').value=sc.bolnaAgentId||'';$('#create-script').dataset.editId=sc.id;$('#create-script').textContent='Update Script';$('#cancel-edit').style.display='inline-block';window.scrollTo({top:0,behavior:'smooth'})});
    renderCampaignsTable(c.campaigns);
    renderJobsTable(j.jobs);
  }catch(e){notice(e.message,true)}
}
function renderCampaignsTable(campaigns){
  $('#ai-campaign-table').innerHTML=`<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Script</th><th>Targets</th><th>Start</th><th>End</th><th>At once</th><th>Status</th><th>Action</th></tr></thead><tbody>${campaigns.map(c=>`<tr><td>${esc(c.name)}</td><td>${esc((window.__scripts||[]).find(s=>s.id===c.scriptId)?.name||c.scriptId)}</td><td>${esc((c.targetStatuses||[]).join(', ')||'All')}</td><td>${esc(new Date(c.startAt).toLocaleString())}</td><td>${esc(new Date(c.endAt).toLocaleString())}</td><td>${c.concurrency||1}</td><td>${badge(c.status||'scheduled')}</td><td>${['scheduled','running'].includes(c.status)?`<button class="btn ghost cancel-ai-campaign" data-id="${c.id}">Cancel</button>`:'-'}</td></tr>`).join('')||'<tr><td colspan="8" class="muted">No scheduled AI campaigns</td></tr>'}</tbody></table></div>`;
  $$('.cancel-ai-campaign').forEach(btn=>btn.onclick=async()=>{if(!confirm('Cancel this AI calling campaign?'))return;try{await api(`/owner/ai-calls/campaigns/${btn.dataset.id}/cancel`,{method:'POST',body:'{}'});notice('Campaign cancelled');loadAI()}catch(e){notice(e.message,true)}})
}
$('#cancel-edit').onclick=()=>{$('#script-name').value='';$('#script-text').value='';$('#script-agent-id').value='';delete $('#create-script').dataset.editId;$('#create-script').textContent='Save Script';$('#cancel-edit').style.display='none'};
function renderJobsTable(jobs){$('#ai-jobs-table').innerHTML=`<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Provider</th><th>Action</th></tr></thead><tbody>${jobs.map(z=>`<tr><td>${esc(z.name||'')}</td><td>${esc(z.phone||'')}</td><td>${badge(z.status)}</td><td>${esc(z.provider||'')}</td><td>${z.status==='queued'?`<button class="btn primary run-job" data-id="${z.id}">Call Now</button>`:z.status==='failed'?`<span class="muted" title="${esc(z.error||'')}">Failed</span>`:'<span class="muted">-</span>'}</td></tr>`).join('')||'<tr><td colspan="5" class="muted">No jobs yet</td></tr>'}</tbody></table></div>`;$$('.run-job').forEach(btn=>btn.onclick=async()=>{btn.disabled=true;btn.textContent='Calling...';try{await api(`/owner/ai-calls/${btn.dataset.id}/run`,{method:'POST',body:'{}'});notice('Call started');loadAI()}catch(e){notice(e.message,true);loadAI()}})}
$('#create-script').onclick=async()=>{try{const editId=$('#create-script').dataset.editId;const body=JSON.stringify({name:$('#script-name').value,matchStatus:$('#script-status').value,script:$('#script-text').value,bolnaAgentId:$('#script-agent-id').value.trim()});const r=editId?await api(`/owner/scripts/${editId}`,{method:'PATCH',body}):await api('/owner/scripts',{method:'POST',body});notice(r.bolnaSyncError?`Script saved, but Bolna sync failed: ${r.bolnaSyncError}`:(editId?'Script updated and synced':'AI script saved and synced'));$('#script-name').value='';$('#script-text').value='';$('#script-agent-id').value='';delete $('#create-script').dataset.editId;$('#create-script').textContent='Save Script';$('#cancel-edit').style.display='none';loadAI()}catch(e){notice(e.message,true)}};
$('#create-ai-campaign').onclick=async()=>{
  try{
    const targetStatuses=$$('.ai-target:checked').map(x=>x.value);
    const startAt=$('#ai-start-at').value, endAt=$('#ai-end-at').value;
    const body=JSON.stringify({name:$('#ai-campaign-name').value,scriptId:$('#ai-campaign-script').value,targetStatuses,startAt,endAt,concurrency:Number($('#ai-concurrency').value||1)});
    const d=await api('/owner/ai-calls/campaigns',{method:'POST',body});
    notice(`AI campaign scheduled: ${d.campaign.name}`);
    $('#ai-campaign-name').value='';
    loadAI();
  }catch(e){notice(e.message,true)}
};
$('#auto-queue').onclick=async()=>{try{const d=await api('/owner/ai-calls/auto-queue',{method:'POST',body:'{}'});notice(`${d.queued} calls queued`);loadAI();loadDashboard()}catch(e){notice(e.message,true)}};
async function loadUsers(){
  try{
    const d=await api('/business/users');
    $('#users-table').innerHTML=`<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Username</th><th>Phone</th><th>Role</th><th>Permissions</th><th>Action</th></tr></thead><tbody>${d.users.map(u=>{
      if(u.role==='owner')return `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${esc(u.phone)}</td><td>OWNER</td><td>Full Access</td><td>-</td></tr>`;
      const p=u.permissions||{};
      const checked=k=>p[k]?'checked':'';
      return `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${esc(u.phone)}</td><td><select class="role-select"><option value="user" ${u.role==='user'?'selected':''}>user</option><option value="manager" ${u.role==='manager'?'selected':''}>manager</option><option value="admin" ${u.role==='admin'?'selected':''}>admin</option></select></td><td class="perm-box"><label><input type="checkbox" data-p="members" ${checked('members')}> Members</label><label><input type="checkbox" data-p="campaigns" ${checked('campaigns')}> Campaigns</label><label><input type="checkbox" data-p="aiCalling" ${checked('aiCalling')}> AI Calling</label><label><input type="checkbox" data-p="activity" ${checked('activity')}> Activity</label></td><td><button class="btn primary save-user" data-id="${u.id}">Save</button></td></tr>`;
    }).join('')}</tbody></table></div>`;
    $$('.save-user').forEach(btn=>btn.onclick=async()=>{
      const row=btn.closest('tr'); const permissions={};
      row.querySelectorAll('[data-p]').forEach(x=>permissions[x.dataset.p]=x.checked);
      try{await api(`/business/users/${btn.dataset.id}`,{method:'PATCH',body:JSON.stringify({role:row.querySelector('.role-select').value,permissions})});notice('User permissions updated');loadUsers()}catch(e){notice(e.message,true)}
    });
  }catch(e){notice(e.message,true)}
}
async function loadActivity(){try{const d=await api('/owner/overview');$('#activity-table').innerHTML='<p class="muted">Activity audit is stored by the backend. The full log viewer can be expanded as the next module.</p><pre>'+JSON.stringify(d,null,2)+'</pre>'}catch(e){notice(e.message,true)}}
function esc(v){return String(v??'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]))}
async function guardOwnerPanel(){
  try {
    const d=await api('/auth/me');
    if(!['owner','admin','manager'].includes(d.user?.role)){ location.href='./'; return; }
    showSection('dashboard');
  } catch { localStorage.removeItem('sai_token'); location.href='./'; }
}
guardOwnerPanel();

// Mobile navigation drawer
(function(){const btn=document.getElementById('admin-menu-toggle'), side=document.querySelector('.admin-side'), overlay=document.getElementById('admin-overlay');if(!btn||!side||!overlay)return;const close=()=>{side.classList.remove('open');overlay.classList.remove('open')};btn.addEventListener('click',()=>{side.classList.toggle('open');overlay.classList.toggle('open')});overlay.addEventListener('click',close);side.querySelectorAll('.nav,.back').forEach(el=>el.addEventListener('click',close));})();
