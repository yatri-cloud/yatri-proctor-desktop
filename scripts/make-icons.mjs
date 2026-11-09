// App icons and the in-app logo come from the shared Yatri Cloud brand files.
import { copyFile, mkdir } from "node:fs/promises";
await mkdir("build", { recursive: true });
for (const f of ["icon.icns", "icon.ico", "icon.png"]) {
  await copyFile(`../yatri-playbook/desktop/build/${f}`, `build/${f}`).catch(() => console.warn(`missing ${f}`));
}
await copyFile("../yatricloud.com/public/logo-192.png", "public/logo.png");
console.log("icons ready");
