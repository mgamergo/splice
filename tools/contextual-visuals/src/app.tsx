import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  applyTrim,
  attribution,
  type Cue,
  cueList,
  duration,
  HEIGHT,
  graphicsOverlap,
  initialPlacements,
  type Placement,
  resolveVisuals,
  type Sample,
  sampleSchema,
  WIDTH,
} from "./model";
import { animate } from "./paint";

const kindNames = {
  focus: "Punch-in",
  label: "Key phrase",
  flow: "Animated diagram",
};
const formatTime = (time: number) =>
  `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, "0")}`;

function App() {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [sample, setSample] = useState<Sample>();
  const [cues, setCues] = useState<Cue[]>([]);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [sourceTime, setSourceTime] = useState(0);
  const [trim, setTrim] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState<"suggest" | "export">();
  const [message, setMessage] = useState("");
  const [download, setDownload] = useState("");
  const visiblePlacements = useMemo(
    () => applyTrim(placements, trim),
    [placements, trim],
  );
  const visuals = useMemo(
    () => resolveVisuals(sample?.drafts ?? [], visiblePlacements),
    [sample, visiblePlacements],
  );
  const context = useRef(visuals);

  useEffect(() => {
    context.current = visuals;
  }, [visuals]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/transcript", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("The transcript could not be loaded.");
        const data = await response.json();
        setCues(cueList.parse(data.cues));
      })
      .catch((error) => {
        if (!controller.signal.aborted) setMessage(String(error));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const source = video.current;
    const surface = canvas.current;
    const ctx = surface?.getContext("2d");
    if (!source || !ctx) return;
    let frame = 0;
    let lastTime = -1;
    let lastVisuals: typeof visuals | undefined;
    function paint() {
      if (!source || !ctx) return;
      const time = source.currentTime;
      if (
        !source.seeking &&
        source.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        (time !== lastTime || lastVisuals !== context.current)
      ) {
        animate(
          ctx,
          (x, y, width, height) => ctx.drawImage(source, x, y, width, height),
          context.current,
          time,
        );
        lastTime = time;
        lastVisuals = context.current;
      }
      frame = requestAnimationFrame(paint);
    }
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(
    () => () => {
      if (download) URL.revokeObjectURL(download);
    },
    [download],
  );

  function seek(time: number) {
    if (!video.current) return;
    video.current.currentTime = Math.min(duration - 0.01, Math.max(trim, time));
    setSourceTime(video.current.currentTime);
  }

  function changeTrim(next: number) {
    if (
      graphicsOverlap(
        resolveVisuals(sample?.drafts ?? [], applyTrim(placements, next)),
      )
    ) {
      setMessage(
        "Move the kept graphic before restoring this part of the opening.",
      );
      return;
    }
    setTrim(next);
    setDownload("");
    setMessage("");
    if (sourceTime < next && video.current) {
      video.current.currentTime = next;
      setSourceTime(next);
    }
  }

  async function suggest() {
    setBusy("suggest");
    setDownload("");
    setMessage("");
    try {
      const response = await fetch("/api/suggest");
      if (!response.ok)
        throw new Error("The visual suggestions could not be loaded.");
      const result = sampleSchema.parse(await response.json());
      setSample(result);
      setPlacements(
        initialPlacements(result, 0).map((item) => ({
          ...item,
          enabled: false,
        })),
      );
      setMessage("Review the suggested visuals and add the ones you want.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(undefined);
    }
  }

  function commitPlacements(next: Placement[]) {
    const nextVisuals = resolveVisuals(
      sample?.drafts ?? [],
      applyTrim(next, trim),
    );
    if (graphicsOverlap(nextVisuals)) {
      setMessage("Move the key phrase or diagram so they do not overlap.");
      return;
    }
    setPlacements(next);
    setDownload("");
    setMessage("");
  }

  function update(cue: number, change: Partial<Omit<Placement, "cue">>) {
    commitPlacements(
      placements.map((item) =>
        item.cue === cue ? { ...item, ...change } : item,
      ),
    );
  }

  async function exportVideo() {
    setBusy("export");
    setDownload("");
    setMessage("Rendering the current edit on the devbox…");
    try {
      const response = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trim, visuals: visiblePlacements }),
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error ?? "The export failed.");
      }
      setDownload(URL.createObjectURL(await response.blob()));
      setMessage("MP4 is ready to download.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(undefined);
    }
  }

  const activeCue = cues.find(
    (cue) => sourceTime >= cue.start && sourceTime < cue.end,
  );
  const applied = visuals.filter((visual) => visual.enabled).length;
  return (
    <main>
      <header>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ◒
          </span>{" "}
          Splice
        </div>
        <div className="header-actions">
          <button
            type="button"
            onClick={exportVideo}
            disabled={busy !== undefined}
          >
            Export MP4
          </button>
          {download && (
            <a
              className="button primary"
              href={download}
              download="splice-contextual-demo.mp4"
            >
              Download MP4
            </a>
          )}
        </div>
      </header>

      <section className="heading">
        <h1>Visuals for spoken ideas</h1>
        <p>A Wikimania interview with Jimmy Wales</p>
      </section>

      <div className="workspace">
        <section className="main-panel" aria-label="Preview and timeline">
          <div className="preview">
            <video
              ref={video}
              src="/media/interview.mp4"
              preload="auto"
              playsInline
              onTimeUpdate={(event) =>
                setSourceTime(event.currentTarget.currentTime)
              }
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onError={() =>
                setMessage("The source video could not be played.")
              }
              tabIndex={-1}
            >
              <track
                kind="captions"
                src="/media/captions.vtt"
                srcLang="en"
                label="English"
              />
            </video>
            <canvas
              ref={canvas}
              width={WIDTH}
              height={HEIGHT}
              aria-label="Video preview"
            />
          </div>
          <div className="transport">
            <button
              type="button"
              onClick={() => {
                const source = video.current;
                if (!source) return;
                if (source.paused) {
                  if (source.currentTime >= duration - 0.1) seek(trim);
                  void source
                    .play()
                    .catch(() => setMessage("Playback could not start."));
                } else source.pause();
              }}
            >
              {playing ? "Pause" : "Play"}
            </button>
            <output aria-label="Playhead">
              {formatTime(Math.max(0, sourceTime - trim))} /{" "}
              {formatTime(duration - trim)}
            </output>
            <label className="trim">
              Trim opening
              <select
                aria-label="Trim opening"
                value={trim}
                disabled={busy !== undefined}
                onChange={(event) =>
                  changeTrim(Number(event.currentTarget.value))
                }
              >
                <option value={0}>0 sec</option>
                <option value={5}>5 sec</option>
                <option value={10}>10 sec</option>
                <option value={20}>20 sec</option>
              </select>
            </label>
          </div>
          <div className="timeline">
            <input
              type="range"
              aria-label="Seek timeline"
              min={trim}
              max={duration}
              step={0.1}
              value={Math.max(trim, sourceTime)}
              onChange={(event) => seek(Number(event.currentTarget.value))}
            />
            <div className="track">
              {visuals
                .filter(({ enabled }) => enabled)
                .map((visual) => (
                  <button
                    type="button"
                    className={`clip ${visual.kind}`}
                    key={visual.cue}
                    title={visual.title}
                    onClick={() => seek(visual.start + 0.65)}
                    style={{
                      left: `${((visual.start - trim) / (duration - trim)) * 100}%`,
                      width: `${(visual.length / (duration - trim)) * 100}%`,
                    }}
                  >
                    {kindNames[visual.kind]}
                  </button>
                ))}
            </div>
          </div>
          <div className="caption">
            <span>Transcript</span>
            <p>
              {activeCue?.text ??
                "Play the clip or select a visual to hear its context."}
            </p>
          </div>
        </section>

        <aside aria-label="Suggested visuals">
          <div className="aside-title">
            <h2>Visuals</h2>
            <span>{applied} on timeline</span>
          </div>
          {!sample ? (
            <div className="empty">
              <p>
                Find moments in the transcript that could use an emphasis or an
                explanation.
              </p>
              <button
                className="primary"
                type="button"
                onClick={suggest}
                disabled={busy !== undefined}
              >
                Suggest visuals
              </button>
            </div>
          ) : (
            <>
              <div className="planner">
                <span>{sample.planner}</span>
                <button
                  type="button"
                  className="quiet"
                  disabled={busy !== undefined || applied === visuals.length}
                  onClick={() =>
                    commitPlacements(
                      placements.map((item) =>
                        item.start >= trim ? { ...item, enabled: true } : item,
                      ),
                    )
                  }
                >
                  Add all
                </button>
              </div>
              {visuals.map((visual) => {
                const cue = cues.find((item) => item.id === visual.cue);
                return (
                  <article className={visual.kind} key={visual.cue}>
                    <div className="visual-type">
                      <span aria-hidden="true"></span>
                      {kindNames[visual.kind]}
                    </div>
                    <h3>{visual.title}</h3>
                    {visual.kind === "flow" && (
                      <p className="steps">{visual.steps.join(" → ")}</p>
                    )}
                    {cue && <blockquote>{cue.text}</blockquote>}
                    <div className="visual-tools">
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => seek(visual.start + 0.65)}
                        aria-label={`Jump to ${visual.title}`}
                      >
                        At {formatTime(visual.start - trim)}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          update(visual.cue, { enabled: !visual.enabled })
                        }
                        disabled={busy !== undefined}
                      >
                        {visual.enabled ? "Remove" : "Add to timeline"}
                      </button>
                    </div>
                    {visual.enabled && (
                      <label className="timing">
                        Start on sequence
                        <input
                          type="number"
                          aria-label={`Start time for ${visual.title}`}
                          min={0}
                          max={duration - trim - visual.length}
                          step={0.1}
                          value={Math.round((visual.start - trim) * 10) / 10}
                          disabled={busy !== undefined}
                          onChange={(event) => {
                            const value = event.currentTarget.valueAsNumber;
                            if (Number.isFinite(value))
                              update(visual.cue, {
                                start: Math.min(
                                  duration - visual.length,
                                  Math.max(trim, trim + value),
                                ),
                              });
                          }}
                        />{" "}
                        sec
                      </label>
                    )}
                  </article>
                );
              })}
              {visuals.length === 0 && (
                <p className="empty">No suggestions remain in this section.</p>
              )}
              <button
                type="button"
                className="quiet reset"
                onClick={suggest}
                disabled={busy !== undefined}
              >
                Reset suggestions
              </button>
            </>
          )}
        </aside>
      </div>
      <div className="status" role="status">
        {message}
      </div>
      <footer>
        Footage by {attribution.creators}.{" "}
        <a href={attribution.source}>Original interview</a> under{" "}
        <a href={attribution.license}>CC BY 4.0</a>. Excerpted and animated in
        Splice.
      </footer>
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
