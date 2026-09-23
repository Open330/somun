import { Component, type ReactNode } from "react";
import { t } from "../i18n";

/**
 * 지연 로딩한 화면 조각을 받지 못했을 때(새 버전 배포로 파일 이름이 바뀐 경우가 대부분).
 * 앱 전체가 기본 오류 화면으로 바뀌지 않게 이 영역만 대신 보여주고, 새로고침으로 새 버전을 받게 한다.
 */
export class ChunkBoundary extends Component<{ children: ReactNode; resetKey?: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(prev: { resetKey?: string }) { if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false }); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="state-panel error-state" role="alert"><span className="state-symbol" aria-hidden>!</span><h2>{t("화면을 불러오지 못했습니다")}</h2><p>{t("새 버전이 배포되었거나 연결이 끊겼을 수 있습니다. 새로고침하면 최신 화면을 받습니다.")}</p><button className="primary" onClick={() => window.location.reload()}>{t("새로고침")}</button></div>;
  }
}
