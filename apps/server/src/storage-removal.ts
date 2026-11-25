import { dlopen } from "bun:ffi";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	type Stats,
} from "node:fs";
import { basename, dirname, parse, toNamespacedPath } from "node:path";
import { sameFileIdentity } from "./file-identity";

export type StorageEntry = { path: string; info: Stats };

type Handle = {
	fd?: number;
	info: () => Stats;
	close: () => void;
	remove: (expected: Stats) => void;
};

function changed(): never {
	throw new Error("Item changed or could not be safely opened.");
}

function sameStorageEntry({ a, b }: { a: Stats; b: Stats }): boolean {
	return (
		a.dev === b.dev &&
		a.mode === b.mode &&
		a.nlink === b.nlink &&
		sameFileIdentity({ a, b })
	);
}

function sameDirectory({ a, b }: { a: Stats; b: Stats }): boolean {
	return (
		a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino
	);
}

type OpenEntry = {
	path: string;
	directory: boolean;
	parent?: Handle;
	remove?: boolean;
};

function posixOpener() {
	const mac = process.platform === "darwin";
	const { symbols } = dlopen(mac ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
		openat: { args: ["i32", "buffer", "i32", "i32"], returns: "i32" },
		unlinkat: { args: ["i32", "buffer", "i32"], returns: "i32" },
	});

	// Resolve a single name relative to an open directory. An ancestor rename
	// or symlink substitution cannot redirect openat or unlinkat.
	return ({ path, directory, parent }: OpenEntry) => {
		const name = Buffer.from(basename(path) + "\0");
		const flags =
			constants.O_NOFOLLOW |
			constants.O_NONBLOCK |
			(directory ? constants.O_DIRECTORY : 0);
		const parentFd = parent?.fd;
		const fd =
			parentFd === undefined
				? openSync(path, flags)
				: symbols.openat(parentFd, name, flags, 0);
		if (fd < 0) changed();
		return {
			fd,
			info: () => fstatSync(fd),
			close: () => closeSync(fd),
			remove(expected: Stats) {
				// AT_REMOVEDIR gives unlinkat the same empty-only behavior as rmdir.
				const flags = directory ? (mac ? 0x80 : 0x200) : 0;
				const named = lstatSync(path);
				if (
					!(directory
						? sameDirectory({ a: expected, b: named })
						: sameStorageEntry({ a: expected, b: named }))
				)
					changed();
				if (
					parentFd === undefined ||
					symbols.unlinkat(parentFd, name, flags) !== 0
				)
					changed();
			},
		};
	};
}

function windowsOpener() {
	const { symbols } = dlopen("kernel32.dll", {
		CreateFileW: {
			args: ["buffer", "u32", "u32", "ptr", "u32", "u32", "ptr"],
			returns: "i64",
		},
		CloseHandle: { args: ["i64"], returns: "i32" },
		GetFileInformationByHandleEx: {
			args: ["i64", "i32", "buffer", "u32"],
			returns: "i32",
		},
		GetFinalPathNameByHandleW: {
			args: ["i64", "buffer", "u32", "u32"],
			returns: "u32",
		},
		SetFileInformationByHandle: {
			args: ["i64", "i32", "buffer", "u32"],
			returns: "i32",
		},
	});

	return ({ path, directory, remove = false }: OpenEntry) => {
		const expectedPath = toNamespacedPath(path);
		const name = Buffer.from(expectedPath + "\0", "utf16le");
		const listDirectory = 0x0001;
		const readAttributes = 0x0080;
		const deleteAccess = 0x00010000;
		const shareRead = 0x0001;
		const openExisting = 3;
		const backupSemantics = 0x02000000;
		const openReparsePoint = 0x00200000;
		// Block rename and ordinary writes while holding the handle. Also check
		// its resolved path before reading metadata or marking it for removal.
		const handle = symbols.CreateFileW(
			name,
			readAttributes |
				(directory ? listDirectory : 0) |
				(remove ? deleteAccess : 0),
			shareRead,
			null,
			openExisting,
			backupSemantics | openReparsePoint,
			null,
		);
		if (handle === -1n) changed();
		const attributeTag = new Uint32Array(2);
		const fileAttributeTagInfo = 9;
		const reparsePoint = 0x0400;
		if (
			!symbols.GetFileInformationByHandleEx(
				handle,
				fileAttributeTagInfo,
				attributeTag,
				8,
			) ||
			(attributeTag[0] ?? 0) & reparsePoint
		) {
			symbols.CloseHandle(handle);
			changed();
		}

		function checkPath() {
			const resolved = Buffer.alloc(name.length);
			const capacity = resolved.length / 2;
			const length = symbols.GetFinalPathNameByHandleW(
				handle,
				resolved,
				capacity,
				0,
			);
			if (!length || length >= capacity) changed();
			const actualPath = resolved.toString("utf16le", 0, length * 2);
			const volumeLength = parse(expectedPath).root.length;
			if (
				actualPath.slice(0, volumeLength).toLowerCase() !==
					expectedPath.slice(0, volumeLength).toLowerCase() ||
				actualPath.slice(volumeLength) !== expectedPath.slice(volumeLength)
			)
				changed();
		}

		return {
			info() {
				checkPath();
				return lstatSync(path);
			},
			close: () => {
				symbols.CloseHandle(handle);
			},
			remove(expected: Stats) {
				checkPath();
				const named = lstatSync(path);
				if (
					!(directory
						? sameDirectory({ a: expected, b: named })
						: sameStorageEntry({ a: expected, b: named }))
				)
					changed();
				// FileDispositionInfo removes through the exact open handle and
				// rejects a nonempty directory.
				const fileDispositionInfo = 4;
				if (
					!symbols.SetFileInformationByHandle(
						handle,
						fileDispositionInfo,
						Uint8Array.of(1),
						1,
					)
				)
					changed();
			},
		};
	};
}

let opener: ((entry: OpenEntry) => Handle) | undefined;

/** Remove only the entries in this snapshot. Report bytes as each leaf is removed. */
export function removeStorageEntry({
	ancestors,
	entry,
	files,
	onRemove,
}: {
	ancestors: StorageEntry[];
	entry: StorageEntry;
	files: StorageEntry[];
	onRemove: (bytes: number) => void;
}) {
	if (!opener) {
		if (process.platform === "win32") opener = windowsOpener();
		else if (process.platform === "linux" || process.platform === "darwin")
			opener = posixOpener();
		else
			throw new Error("Safe cleanup is unavailable on this operating system.");
	}
	const open = opener;
	const handles: Handle[] = [];
	try {
		// Start at the filesystem root to avoid following substituted links
		// above the managed root before reaching the inventoried directories.
		const managedRoot = ancestors[0]?.path;
		if (!managedRoot) changed();
		const volume = parse(managedRoot).root;
		const prefix: string[] = [];
		for (let path = managedRoot; path !== volume; ) {
			path = dirname(path);
			prefix.unshift(path);
		}
		for (const path of prefix)
			handles.push(open({ path, directory: true, parent: handles.at(-1) }));
		for (const ancestor of ancestors) {
			const handle = open({
				path: ancestor.path,
				directory: true,
				parent: handles.at(-1),
			});
			handles.push(handle);
			if (!sameDirectory({ a: ancestor.info, b: handle.info() })) changed();
		}

		// On POSIX a held directory can be moved. Recheck that it is still
		// attached at its managed path before each descriptor-relative removal.
		function recheckAncestors() {
			if (process.platform === "win32") return;
			for (const { path, info } of ancestors)
				if (!sameDirectory({ a: info, b: lstatSync(path) })) changed();
		}

		const directory = entry.info.isDirectory();
		if (dirname(entry.path) !== ancestors.at(-1)?.path) changed();
		if (!directory && !entry.info.isFile()) changed();
		const item = open({
			path: entry.path,
			directory,
			parent: handles.at(-1),
			remove: true,
		});
		handles.push(item);
		recheckAncestors();
		if (!sameStorageEntry({ a: entry.info, b: item.info() })) changed();
		if (!directory) {
			item.remove(entry.info);
			onRemove(entry.info.size);
			return;
		}

		// Validate the whole job before removing any files. Open each leaf
		// again just before removal so a replaced entry is kept.
		function validateFile({
			file,
			remove,
		}: {
			file: StorageEntry;
			remove: boolean;
		}) {
			if (dirname(file.path) !== entry.path || !file.info.isFile()) changed();
			if (remove) {
				recheckAncestors();
				if (!sameDirectory({ a: entry.info, b: lstatSync(entry.path) }))
					changed();
			}
			const leaf = open({
				path: file.path,
				directory: false,
				parent: item,
				remove,
			});
			try {
				if (!sameStorageEntry({ a: file.info, b: leaf.info() })) changed();
				if (remove) leaf.remove(file.info);
			} finally {
				leaf.close();
			}
		}
		for (const file of files) validateFile({ file, remove: false });
		if (!sameStorageEntry({ a: entry.info, b: item.info() })) changed();
		for (const file of files) {
			validateFile({ file, remove: true });
			onRemove(file.info.size);
		}
		recheckAncestors();
		if (!sameDirectory({ a: entry.info, b: lstatSync(entry.path) })) changed();
		item.remove(entry.info);
	} finally {
		for (const handle of handles.reverse()) handle.close();
	}
}
