import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    globals: true,
    restoreMocks: true,
    // skill/ 은 트랙 1 스킬의 독립 저장소다. 자체 vitest 설정과 package.json 을 가지며
    // 테스트가 skill/ 을 작업 디렉터리로 가정한 상대경로를 쓴다. 루트에서 함께 돌리면
    // 경로가 어긋나 실패하므로 제외한다. 그쪽 테스트는 `npm --prefix skill test` 로 돈다.
    exclude: ["**/node_modules/**", "**/dist/**", "skill/**"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
