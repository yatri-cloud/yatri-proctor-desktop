import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { faceModel } from "./lib/monitor";
import { measureConnection } from "./lib/speedtest";

// Used by the --smoke check in CI: proves the AI model loads in the packaged app.
(window as unknown as { __ypModelTest: () => Promise<string> }).__ypModelTest = () =>
  faceModel().then(() => "ok", (e: Error) => `fail ${e.message}`);

// Used by tests to compare the connection test with a reference speed test.
(window as unknown as { __ypSpeedTest: () => Promise<unknown> }).__ypSpeedTest = () => measureConnection(() => {});

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
