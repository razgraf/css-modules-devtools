import { card } from "./Card.module.css";
import * as ns from "./Card.module.css";
const legacy = require("./Button.module.css");
const { button: btn } = require("./Button.module.css");

export const Card = () => <div className={`${card} ${ns.card} ${legacy.button} ${btn}`} />;
