import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./lib/auth/context";
import { useLocale } from "./i18n";
import "./styles.css";

const router = createBrowserRouter([{ path: "*", element: <App /> }]);

/** 언어를 바꾸면 화면 전체를 새 언어로 다시 그린다(주소는 라우터가 그대로 둔다). */
function Root() {
  const locale = useLocale();
  return <RouterProvider key={locale} router={router} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <Root />
    </AuthProvider>
  </StrictMode>,
);
