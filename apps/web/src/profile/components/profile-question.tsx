"use client";

import { useEffect, useState, type FormEvent } from "react";
import { profileQuestionSchema } from "@splice/bridge/profile";
import { useAgentBridgeStore } from "@/bridge/bridge-store";
import { callSplice } from "@/bridge/splice-api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Question = ReturnType<typeof profileQuestionSchema.parse>;

export function ProfileQuestionCard() {
	const connected = useAgentBridgeStore(
		(state) => state.status === "connected",
	);
	return connected ? <ProfileQuestionPoller /> : null;
}

function ProfileQuestionPoller() {
	const [question, setQuestion] = useState<Question | null>(null);
	const [closedId, setClosedId] = useState<string>();

	useEffect(() => {
		let live = true;
		let timer: ReturnType<typeof setTimeout>;
		async function poll() {
			try {
				const response = await callSplice({ method: "profile.question" });
				if (live) setQuestion(profileQuestionSchema.nullable().parse(response));
			} catch {
				// Recheck on the next poll if splice restarted or is unavailable.
			} finally {
				if (live) timer = setTimeout(() => void poll(), 5_000);
			}
		}
		void poll();
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, []);

	if (!question || question.id === closedId) return null;
	return (
		<QuestionForm
			key={question.id}
			question={question}
			onClose={() => setClosedId(question.id)}
		/>
	);
}

function QuestionForm({
	question,
	onClose,
}: {
	question: Question;
	onClose: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	async function respond(answer?: string) {
		if (answer !== undefined && !answer.trim()) {
			setError("Enter an answer or dismiss the question.");
			return;
		}
		setBusy(true);
		setError("");
		try {
			await callSplice({
				method: "profile.respond",
				params:
					answer === undefined
						? { kind: "dismiss", id: question.id }
						: { kind: "answer", id: question.id, answer },
			});
			onClose();
		} catch {
			setError("Could not save your response. Try again.");
			setBusy(false);
		}
	}

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const answer = new FormData(event.currentTarget).get("answer");
		if (typeof answer === "string") void respond(answer);
	}

	return (
		<aside
			aria-label="Profile question"
			className="bg-popover text-popover-foreground fixed right-4 top-16 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-md border p-4 shadow-lg"
		>
			<form className="space-y-3" onSubmit={submit}>
				<p className="text-xs font-medium text-muted-foreground" role="status">
					Profile question
				</p>
				<label className="block space-y-2 text-sm">
					<span className="block wrap-anywhere">{question.text}</span>
					<Textarea
						name="answer"
						placeholder="Your answer"
						maxLength={2000}
						disabled={busy}
					/>
				</label>
				{error && (
					<p role="alert" className="text-sm">
						{error}
					</p>
				)}
				<div className="flex justify-end gap-2">
					<Button
						variant="ghost"
						size="sm"
						type="button"
						disabled={busy}
						onClick={() => void respond()}
					>
						Dismiss
					</Button>
					<Button size="sm" type="submit" disabled={busy}>
						Save answer
					</Button>
				</div>
			</form>
		</aside>
	);
}
