/** Remotion CLI / Studio settings (the render server passes the same options programmatically). */
import { Config } from "@remotion/cli/config";
import { browserExecutable } from "./src/lib/browser";

Config.setVideoImageFormat("jpeg");
Config.setChromiumOpenGlRenderer("swangle");
Config.setConcurrency(3);
Config.setCrf(20);
if (browserExecutable()) Config.setBrowserExecutable(browserExecutable());
