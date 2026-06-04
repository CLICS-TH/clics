function getUser() {
  const raw = localStorage.getItem('clics_user');
  return raw ? JSON.parse(raw) : null;
}
function guardPage() {
  if (!localStorage.getItem('clics_token')) window.location.href = '/';
}
function guardRole(...roles) {
  const user = getUser();
  if (!user || !roles.includes(user.role)) window.location.href = '/';
}
window.auth = { getUser, guardPage, guardRole };
