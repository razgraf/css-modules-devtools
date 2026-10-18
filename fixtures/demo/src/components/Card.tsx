import styles from "./Card.module.css";

export function Card({ title, children }) {
	return (
		<article className={styles.card}>
			<h2 className={styles.title}>{title}</h2>
			{children}
		</article>
	);
}
