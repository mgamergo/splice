"use client";

import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Check, ListCheck, Trash2 } from "lucide-react";
import { cn } from "@/utils/ui";
import { useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
	DialogTrigger,
} from "@/components/ui/dialog";
import { canDeleteSequence, getMainSequence } from "@/timeline/sequences";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";

export function SequencesView({ children }: { children: React.ReactNode }) {
	const editor = useEditor();
	const sequences = editor.sequences.getSequences();
	const currentSequence = editor.sequences.getActiveSequence();
	const [isSelectMode, setIsSelectMode] = useState(false);
	const [selectedSequences, setSelectedSequences] = useState<Set<string>>(new Set());

	const handleSequenceSwitch = async (sequenceId: string) => {
		if (isSelectMode) {
			toggleSequenceSelection({ sequenceId });
			return;
		}

		try {
			await editor.sequences.switchToSequence({ sequenceId });
		} catch (error) {
			console.error("Failed to switch sequence:", error);
		}
	};

	const toggleSequenceSelection = ({ sequenceId }: { sequenceId: string }) => {
		setSelectedSequences((prev) => {
			const newSet = new Set(prev);
			if (newSet.has(sequenceId)) {
				newSet.delete(sequenceId);
			} else {
				newSet.add(sequenceId);
			}
			return newSet;
		});
	};

	const handleSelectMode = () => {
		setIsSelectMode(!isSelectMode);
		setSelectedSequences(new Set());
	};

	const handleDeleteSelected = async () => {
		for (const sequenceId of selectedSequences) {
			const sequence = sequences.find((sequence) => sequence.id === sequenceId);
			if (!sequence) {
				continue;
			}

			const { canDelete, reason } = canDeleteSequence({ sequence });
			if (!canDelete) {
				toast.error(reason || "Failed to delete sequence");
				continue;
			}

			try {
				await editor.sequences.deleteSequence({ sequenceId });
			} catch (error) {
				console.error("Failed to delete sequence:", error);
			}
		}
		setSelectedSequences(new Set());
		setIsSelectMode(false);
	};

	const isMainSequenceSelected = (() => {
		const mainSequence = getMainSequence({ sequences });
		return Boolean(mainSequence?.id && selectedSequences.has(mainSequence.id));
	})();

	return (
		<Sheet>
			<SheetTrigger asChild>{children}</SheetTrigger>
			<SheetContent>
				<SheetHeader>
					<SheetTitle>
						{isSelectMode ? `Select sequences (${selectedSequences.size})` : "Sequences"}
					</SheetTitle>
					<SheetDescription>
						{isSelectMode
							? "Select sequences to delete"
							: "Switch between sequences in your project"}
					</SheetDescription>
				</SheetHeader>
				<div className="flex flex-col gap-4 py-4">
					<div className="flex items-center gap-2">
						<Button
							className="rounded-md"
							variant={isSelectMode ? "default" : "outline"}
							size="sm"
							onClick={handleSelectMode}
						>
							<ListCheck />
							{isSelectMode ? "Cancel" : "Select"}
						</Button>
						{isSelectMode && (
							<DeleteDialog
								count={selectedSequences.size}
								onDelete={handleDeleteSelected}
								disabled={isMainSequenceSelected}
								trigger={
									<Button
										className="rounded-md"
										variant="destructive"
										disabled={isMainSequenceSelected}
										size="sm"
									>
										<Trash2 />
										Delete ({selectedSequences.size})
									</Button>
								}
							/>
						)}
					</div>
					{sequences.length === 0 ? (
						<div className="text-muted-foreground text-sm">
							No sequences available
						</div>
					) : (
						<div className="space-y-2">
							{sequences.map((sequence) => (
								<Button
									key={sequence.id}
									variant="outline"
									className={cn(
										"w-full justify-between font-normal",
										currentSequence?.id === sequence.id &&
											!isSelectMode &&
											"border-primary !text-primary",
										isSelectMode &&
											selectedSequences.has(sequence.id) &&
											"bg-accent border-foreground/30",
									)}
									onClick={() => handleSequenceSwitch(sequence.id)}
								>
									<span>{sequence.name}</span>
									<div className="flex items-center gap-2">
										{((isSelectMode && selectedSequences.has(sequence.id)) ||
											(!isSelectMode && currentSequence?.id === sequence.id)) && (
											<Check className="size-4" />
										)}
									</div>
								</Button>
							))}
						</div>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}

function DeleteDialog({
	count,
	onDelete,
	disabled,
	trigger,
}: {
	count: number;
	onDelete: () => void;
	disabled?: boolean;
	trigger: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);

	const handleDelete = () => {
		onDelete();
		setOpen(false);
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>{trigger}</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Delete Sequences</DialogTitle>
					<DialogDescription>
						Are you sure you want to delete {count} sequence
						{count === 1 ? "" : "s"}? This action cannot be undone.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button
						variant="destructive"
						onClick={handleDelete}
						disabled={disabled}
					>
						Delete
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
