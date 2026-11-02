import { mountApp, mountMirror } from "@rojibura/city-client";

const root = document.getElementById("app");
// the mirror an AI rehearses its body in (docs/prd.md 3.4.11): no city, no connection
if (root) location.pathname === "/mirror" ? mountMirror(root) : mountApp(root);
