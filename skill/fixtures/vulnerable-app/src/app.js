// 고의로 취약점을 심은 테스트용 앱입니다. 실제로 배포하지 마세요.
const FB = {
  key: 'AIzaSyD1234567890123456789012345678901234',
  projectId: 'demo-class',
}
const ADMIN_PW = '1234' // 비밀번호: 1234

export function login(pw) {
  if (pw === '1234') {
    localStorage.setItem('isTeacher', 'true')
    return true
  }
  return false
}

export function showResult(name, html) {
  document.getElementById('root').innerHTML = '<h1>' + name + '</h1>' + html
  console.log('로그인한 학생', { name, jumin: '990101-1234567' })
}

export async function loadAll(supabase) {
  const { data } = await supabase.from('students').select('*')
  return data
}

navigator.geolocation.getCurrentPosition(() => {})
const DEBUG_MODE = true
