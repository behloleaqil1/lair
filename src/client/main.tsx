import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { applyPreferences, loadPreferences } from "./ui/preferences";

// The theme and density before the first render (index.html sets them too, before the first paint)
applyPreferences(loadPreferences());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
