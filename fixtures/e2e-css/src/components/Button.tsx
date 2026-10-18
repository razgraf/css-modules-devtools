import styles from "./Button.module.css";
import base from "@/styles/base.module.css";

export function Button({ variant }: { variant: string }) {
	return (
		<button
			className={`${styles.button} ${styles["primary-action"]} ${styles[variant]} ${base.reset}`}
			style={{ color: "var(--brand)" }}
		>
			<span className={styles.icon} />
			<span className={styles.missing} />
		</button>
	);
}
