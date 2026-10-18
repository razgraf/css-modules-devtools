import styles from "./Button.module.css";

export function Button({ children }) {
	return (
		<button className={styles.button}>
			{children}
		</button>
	);
}
