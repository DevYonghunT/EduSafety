// 고의로 취약점을 심은 테스트용 컴포넌트입니다. 실제로 배포하지 마세요.
export function Widget({ html }) {
  return <div dangerouslySetInnerHTML={{ __html: html }} />
}
