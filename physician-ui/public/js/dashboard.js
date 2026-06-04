auth.guardPage();
auth.guardRole('physician');
const user = auth.getUser();
document.getElementById('greeting').textContent = `สวัสดี, ${user.full_name_th || user.full_name_en}`;

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api.logout();
  localStorage.clear();
  window.location.href = '/';
});

const STATUS_LABELS = {
  active: 'กำลังดำเนินการ / Active',
  ended: 'สิ้นสุดแล้ว / Ended',
  cle_pass: 'ผ่าน CLE / Passed',
  cle_fail_t1: 'ไม่ผ่าน CLE / Failed',
  cle_flag_t2: 'รอตรวจสอบ / Under Review',
  evaluated: 'ประเมินแล้ว / Evaluated',
};

function renderPlEs(ples) {
  const container = document.getElementById('pleList');
  if (!ples.length) {
    container.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:40px">ยังไม่มี PLE — เริ่มต้นได้เลย!</p>';
    return;
  }
  container.innerHTML = ples.map(p => `
    <div class="card" style="cursor:pointer" onclick="window.location.href='/ple-chat?id=${p.id}'">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <p style="font-weight:600;margin-bottom:4px">PLE ${new Date(p.started_at).toLocaleDateString('th-TH')}</p>
          <p style="font-size:12px;color:#64748b">${p.turn_count ?? 0} รอบ · ${p.token_count ?? 0} tokens</p>
        </div>
        <span class="badge badge-${p.status}">${STATUS_LABELS[p.status] ?? p.status}</span>
      </div>
    </div>`).join('');
}

api.getPlEs().then(ples => renderPlEs(ples ?? [])).catch(() => {
  document.getElementById('pleList').innerHTML = '<p class="error-msg">โหลดข้อมูลไม่สำเร็จ</p>';
});
