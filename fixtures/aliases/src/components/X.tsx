import a from "~styles/a.module.css";
import b from "#styles/a.module.css";
import c from "@theme/theme.module.css";
import d from "./does-not-exist.module.css";

export const X = () => <div className={`${a.a} ${b.a} ${c.themed} ${d.x}`} />;
