import { useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'filament-swapper-state-v1';

function uid() {
  return crypto.randomUUID();
}

function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) {
      return { projects: [], selectedProjectId: null };
    }

    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed.projects)) {
      return { projects: [], selectedProjectId: null };
    }

    return {
      projects: parsed.projects.map((project) => ({
        ...project,
        currentAms: Array.isArray(project.currentAms) ? project.currentAms : [],
        plates: Array.isArray(project.plates)
          ? project.plates.map((plate) => ({
              ...plate,
              printMinutes: Number(plate.printMinutes) > 0 ? Number(plate.printMinutes) : 0,
              printing: Boolean(plate.printing),
            }))
          : [],
      })),
      selectedProjectId: parsed.selectedProjectId ?? null,
    };
  } catch {
    return { projects: [], selectedProjectId: null };
  }
}

function colorFrequency(plates) {
  const freq = new Map();
  for (const plate of plates) {
    for (const colorId of plate.colorIds) {
      freq.set(colorId, (freq.get(colorId) ?? 0) + 1);
    }
  }
  return freq;
}

function chooseNextSet(currentSet, requiredSet, futurePlates, slots) {
  const freq = colorFrequency(futurePlates);
  const next = new Set(requiredSet);

  const candidates = [...currentSet].filter((c) => !next.has(c));
  candidates.sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0));

  for (const colorId of candidates) {
    if (next.size >= slots) {
      break;
    }
    next.add(colorId);
  }

  const remaining = new Set();
  for (const plate of futurePlates) {
    for (const colorId of plate.colorIds) {
      if (!next.has(colorId)) {
        remaining.add(colorId);
      }
    }
  }

  for (const colorId of remaining) {
    if (next.size >= slots) {
      break;
    }
    next.add(colorId);
  }

  return next;
}

function buildPlan(project, currentAms, timeSortOrder) {
  const slots = Number(project.amsSlots) || 4;
  const remaining = project.plates.filter((p) => !p.printed);
  let currentSet = new Set(currentAms);
  const pending = [...remaining];
  const steps = [];
  let totalSwaps = 0;

  while (pending.length > 0) {
    const prioritizePrinting = pending.some((p) => p.printing);
    let bestIndex = 0;
    let bestMissing = Number.POSITIVE_INFINITY;
    let bestOverlap = -1;
    let bestFutureScore = -1;
    let bestPrintMinutes =
      timeSortOrder === 'desc' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    const freq = colorFrequency(pending);

    for (let i = 0; i < pending.length; i += 1) {
      if (prioritizePrinting && !pending[i].printing) {
        continue;
      }

      const req = new Set(pending[i].colorIds);
      const printMinutes = Number(pending[i].printMinutes) > 0 ? Number(pending[i].printMinutes) : 0;
      let missing = 0;
      let overlap = 0;
      for (const colorId of req) {
        if (currentSet.has(colorId)) {
          overlap += 1;
        } else {
          missing += 1;
        }
      }

      let futureScore = 0;
      for (const colorId of req) {
        futureScore += freq.get(colorId) ?? 0;
      }

      const betterByTime =
        timeSortOrder === 'desc'
          ? printMinutes > bestPrintMinutes
          : printMinutes < bestPrintMinutes;

      const isBetter =
        missing < bestMissing ||
        (missing === bestMissing &&
          betterByTime) ||
        (missing === bestMissing &&
          printMinutes === bestPrintMinutes &&
          overlap > bestOverlap) ||
        (missing === bestMissing &&
          printMinutes === bestPrintMinutes &&
          overlap === bestOverlap &&
          futureScore > bestFutureScore);

      if (isBetter) {
        bestMissing = missing;
        bestOverlap = overlap;
        bestFutureScore = futureScore;
        bestPrintMinutes = printMinutes;
        bestIndex = i;
      }
    }

    const plate = pending.splice(bestIndex, 1)[0];
    const requiredSet = new Set(plate.colorIds);
    const requiresPauseAndFilamentSwap = requiredSet.size > slots;
    const nextSet = chooseNextSet(currentSet, requiredSet, pending, slots);

    let swaps = 0;
    const remove = [];
    const add = [];

    for (const colorId of currentSet) {
      if (!nextSet.has(colorId)) {
        remove.push(colorId);
      }
    }

    for (const colorId of nextSet) {
      if (!currentSet.has(colorId)) {
        swaps += 1;
        add.push(colorId);
      }
    }

    totalSwaps += swaps;

    steps.push({
      plateId: plate.id,
      plateName: plate.name,
      printMinutes: Number(plate.printMinutes) > 0 ? Number(plate.printMinutes) : 0,
      required: [...requiredSet],
      before: [...currentSet],
      after: [...nextSet],
      swaps,
      swapOut: remove,
      swapIn: add,
      requiresPauseAndFilamentSwap,
    });

    currentSet = nextSet;
  }

  return { error: null, steps, totalSwaps };
}

function App() {
  const [state, setState] = useState(loadState);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectSlots, setNewProjectSlots] = useState(4);
  const [projectNameDraft, setProjectNameDraft] = useState('');
  const [projectSlotsDraft, setProjectSlotsDraft] = useState('');

  const [newColorName, setNewColorName] = useState('');
  const [newPlateName, setNewPlateName] = useState('');
  const [newPlateMinutes, setNewPlateMinutes] = useState('');
  const [newPlateColors, setNewPlateColors] = useState([]);
  const [planTimeSortOrder, setPlanTimeSortOrder] = useState('asc');
  const [plateMinuteDrafts, setPlateMinuteDrafts] = useState({});
  const [plateNameDrafts, setPlateNameDrafts] = useState({});

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const selectedProject = useMemo(() => {
    return state.projects.find((p) => p.id === state.selectedProjectId) ?? null;
  }, [state.projects, state.selectedProjectId]);

  const sortedProjectColors = useMemo(() => {
    if (!selectedProject) {
      return [];
    }

    return [...selectedProject.colors].sort((a, b) => a.name.localeCompare(b.name));
  }, [selectedProject]);

  useEffect(() => {
    if (!selectedProject) {
      setNewPlateColors([]);
      setPlateMinuteDrafts({});
      setPlateNameDrafts({});
      setProjectNameDraft('');
      setProjectSlotsDraft('');
      return;
    }

    setNewPlateColors((prev) => prev.filter((id) => selectedProject.colors.some((c) => c.id === id)));
    setPlateMinuteDrafts({});
    setPlateNameDrafts({});
    setProjectNameDraft(selectedProject.name);
    setProjectSlotsDraft(String(selectedProject.amsSlots));
  }, [selectedProject]);

  const currentAms = useMemo(() => {
    if (!selectedProject) {
      return [];
    }

    return (selectedProject.currentAms ?? []).filter((id) => selectedProject.colors.some((color) => color.id === id));
  }, [selectedProject]);

  const planner = useMemo(() => {
    if (!selectedProject) {
      return { error: null, steps: [], totalSwaps: 0 };
    }

    return buildPlan(selectedProject, currentAms, planTimeSortOrder);
  }, [selectedProject, currentAms, planTimeSortOrder]);

  const completedPlates = selectedProject ? selectedProject.plates.filter((p) => p.printed) : [];

  function updateProject(projectId, updater) {
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((project) => {
        if (project.id !== projectId) {
          return project;
        }
        return updater(project);
      }),
    }));
  }

  function createProject(event) {
    event.preventDefault();
    const name = newProjectName.trim();
    const slots = Math.max(1, Number(newProjectSlots) || 4);
    if (!name) {
      return;
    }

    const project = {
      id: uid(),
      name,
      amsSlots: slots,
      colors: [],
      plates: [],
      currentAms: [],
    };

    setState((prev) => ({
      projects: [...prev.projects, project],
      selectedProjectId: project.id,
    }));

    setNewProjectName('');
    setNewProjectSlots(4);
  }

  function addColor(event) {
    event.preventDefault();
    if (!selectedProject) {
      return;
    }

    const name = newColorName.trim();
    if (!name) {
      return;
    }

    updateProject(selectedProject.id, (project) => ({
      ...project,
      colors: [...project.colors, { id: uid(), name }],
    }));

    setNewColorName('');
  }

  function addPlate(event) {
    event.preventDefault();
    if (!selectedProject) {
      return;
    }

    const name = newPlateName.trim();
    const printMinutes = Math.max(0, parseInt(newPlateMinutes, 10) || 0);
    if (!name) {
      return;
    }

    updateProject(selectedProject.id, (project) => ({
      ...project,
      plates: [
        ...project.plates,
        {
          id: uid(),
          name,
          printMinutes,
          colorIds: newPlateColors,
          printed: false,
          printing: false,
        },
      ],
    }));

    setNewPlateName('');
    setNewPlateMinutes('');
    setNewPlateColors([]);
  }

  function togglePlateColor(colorId) {
    setNewPlateColors((prev) => {
      if (prev.includes(colorId)) {
        return prev.filter((id) => id !== colorId);
      }
      return [...prev, colorId];
    });
  }

  function toggleExistingPlateColor(plateId, colorId) {
    if (!selectedProject) {
      return;
    }

    updateProject(selectedProject.id, (project) => ({
      ...project,
      plates: project.plates.map((plate) => {
        if (plate.id !== plateId) {
          return plate;
        }

        const hasColor = plate.colorIds.includes(colorId);
        return {
          ...plate,
          colorIds: hasColor
            ? plate.colorIds.filter((id) => id !== colorId)
            : [...plate.colorIds, colorId],
        };
      }),
    }));
  }

  function updatePlateMinutes(plateId, minutes) {
    if (!selectedProject) {
      return;
    }

    const parsed = Math.max(0, Number(minutes) || 0);
    updateProject(selectedProject.id, (project) => ({
      ...project,
      plates: project.plates.map((plate) => {
        if (plate.id !== plateId) {
          return plate;
        }

        return {
          ...plate,
          printMinutes: parsed,
        };
      }),
    }));
  }

  function handlePlateMinutesDraftChange(plateId, value) {
    if (!/^\d*$/.test(value)) {
      return;
    }

    setPlateMinuteDrafts((prev) => ({
      ...prev,
      [plateId]: value,
    }));
  }

  function commitPlateMinutesDraft(plateId) {
    const draft = plateMinuteDrafts[plateId];
    if (draft === undefined) {
      return;
    }

    const parsed = Math.max(0, parseInt(draft, 10) || 0);
    updatePlateMinutes(plateId, parsed);

    setPlateMinuteDrafts((prev) => {
      const next = { ...prev };
      delete next[plateId];
      return next;
    });
  }

  function handlePlateNameDraftChange(plateId, value) {
    setPlateNameDrafts((prev) => ({
      ...prev,
      [plateId]: value,
    }));
  }

  function commitPlateNameDraft(plateId) {
    const draft = plateNameDrafts[plateId];
    if (draft === undefined || !selectedProject) {
      return;
    }

    const trimmed = draft.trim();
    if (!trimmed) {
      setPlateNameDrafts((prev) => {
        const next = { ...prev };
        delete next[plateId];
        return next;
      });
      return;
    }

    updateProject(selectedProject.id, (project) => ({
      ...project,
      plates: project.plates.map((plate) => {
        if (plate.id !== plateId) {
          return plate;
        }
        return { ...plate, name: trimmed };
      }),
    }));

    setPlateNameDrafts((prev) => {
      const next = { ...prev };
      delete next[plateId];
      return next;
    });
  }

  function togglePrinted(plateId) {
    if (!selectedProject) {
      return;
    }

    updateProject(selectedProject.id, (project) => ({
      ...project,
      plates: project.plates.map((plate) => {
        if (plate.id !== plateId) {
          return plate;
        }

        return {
          ...plate,
          printed: !plate.printed,
          printing: plate.printed ? plate.printing : false,
        };
      }),
    }));
  }

  function togglePrinting(plateId) {
    if (!selectedProject) {
      return;
    }

    updateProject(selectedProject.id, (project) => ({
      ...project,
      plates: project.plates.map((plate) => {
        if (plate.printed) {
          return plate;
        }

        if (plate.id === plateId) {
          return {
            ...plate,
            printing: !plate.printing,
          };
        }

        return {
          ...plate,
          printing: false,
        };
      }),
    }));
  }

  function commitProjectSettings() {
    if (!selectedProject) {
      return;
    }

    const name = projectNameDraft.trim();
    const slots = Math.max(1, parseInt(projectSlotsDraft, 10) || 1);
    if (!name) {
      setProjectNameDraft(selectedProject.name);
      setProjectSlotsDraft(String(selectedProject.amsSlots));
      return;
    }

    updateProject(selectedProject.id, (project) => ({
      ...project,
      name,
      amsSlots: slots,
      currentAms: project.currentAms ?? [],
    }));

    setProjectNameDraft(name);
    setProjectSlotsDraft(String(slots));
  }

  function removeColor(colorId) {
    if (!selectedProject) {
      return;
    }

    const blockingPlate = selectedProject.plates.find((plate) => plate.colorIds.includes(colorId));
    if (blockingPlate) {
      return;
    }

    updateProject(selectedProject.id, (project) => ({
      ...project,
      colors: project.colors.filter((color) => color.id !== colorId),
      currentAms: (project.currentAms ?? []).filter((id) => id !== colorId),
      plates: project.plates.map((plate) => ({
        ...plate,
        colorIds: plate.colorIds.filter((id) => id !== colorId),
      })),
    }));
  }

  function togglePlanColor(colorId) {
    if (!selectedProject) {
      return;
    }

    updateProject(selectedProject.id, (project) => {
      const existing = (project.currentAms ?? []).filter((id) => project.colors.some((color) => color.id === id));

      if (existing.includes(colorId)) {
        return {
          ...project,
          currentAms: existing.filter((id) => id !== colorId),
        };
      }

      return {
        ...project,
        currentAms: [...existing, colorId],
      };
    });
  }

  function setSelectedProjectId(projectId) {
    setState((prev) => ({
      ...prev,
      selectedProjectId: projectId,
    }));
  }

  const colorNameById = new Map((selectedProject?.colors ?? []).map((c) => [c.id, c.name]));
  const usedColorIds = new Set((selectedProject?.plates ?? []).flatMap((plate) => plate.colorIds));
  const printingPlateIds = new Set(
    (selectedProject?.plates ?? []).filter((plate) => plate.printing && !plate.printed).map((plate) => plate.id)
  );
  const hasPrintingPlate = printingPlateIds.size > 0;
  const activePlates = selectedProject
    ? [...selectedProject.plates]
        .filter((p) => !p.printed)
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  function colorsForPlate(plate) {
    return [...sortedProjectColors].sort((a, b) => {
      const aSelected = plate.colorIds.includes(a.id);
      const bSelected = plate.colorIds.includes(b.id);

      if (aSelected && !bSelected) {
        return -1;
      }

      if (!aSelected && bSelected) {
        return 1;
      }

      return a.name.localeCompare(b.name);
    });
  }

  return (
    <main className="min-h-screen bg-slate-100 py-8 text-slate-900">
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <h1 className="text-3xl font-bold">Filament Swap Planner</h1>
        <details className="mt-3 rounded-lg border border-slate-300 bg-white p-4">
          <summary className="cursor-pointer text-sm font-semibold text-slate-800">
            Help and usage notes
          </summary>
          <div className="mt-3 space-y-2 text-sm text-slate-700">
            <p>
              This planner helps minimize filament color swaps in your AMS by suggesting a practical print order
              across your plates.
            </p>
            <p>
              It is intended for short-term projects and small sets of print plates, not long-running production queues.
            </p>
            <p className="rounded-md bg-sky-100 px-3 py-2 text-sky-900">
              Privacy note: your data is stored in your browser local storage only. No project data is sent to any
              server.
            </p>
            <p className="font-semibold">General steps</p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Create a project and set your AMS slot count.</li>
              <li>Add the filament colors needed for the project.</li>
              <li>Add each plate, set colors, and optionally add estimated print time.</li>
              <li>In Plan, choose what colors are currently in the AMS.</li>
              <li>Follow the suggested order and swap instructions, then mark plates printed.</li>
            </ol>
            <p className="rounded-md bg-amber-100 px-3 py-2 text-amber-900">
              Hobby disclaimer: this site is built for hobbyists and hobby workflows. It is not intended for serious
              print-farm scheduling or production-critical planning.
            </p>
          </div>
        </details>

        <section className="mt-8 grid gap-6 rounded-xl bg-white p-6 shadow">
          <h2 className="text-xl font-semibold">New Project</h2>
          <form className="grid gap-4 md:grid-cols-3" onSubmit={createProject}>
            <label className="grid gap-2 text-sm font-medium">
              Project name
              <input
                className="rounded-md border border-slate-300 px-3 py-2"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="Cosplay Helmet"
              />
            </label>

            <label className="grid gap-2 text-sm font-medium">
              AMS color slots
              <input
                type="number"
                min={1}
                className="rounded-md border border-slate-300 px-3 py-2"
                value={newProjectSlots}
                onChange={(e) => setNewProjectSlots(e.target.value)}
              />
            </label>

            <div className="flex items-end">
              <button
                type="submit"
                className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              >
                Create project
              </button>
            </div>
          </form>
        </section>

        <section className="mt-8 grid gap-6 lg:grid-cols-4">
          <aside className="rounded-xl bg-white p-6 shadow lg:col-span-1">
            <h2 className="text-lg font-semibold">Projects</h2>
            <ul className="mt-4 space-y-2">
              {state.projects.map((project) => (
                <li key={project.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedProjectId(project.id)}
                    className={`w-full rounded-md border px-3 py-2 text-left text-sm ${
                      state.selectedProjectId === project.id
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <div className="font-medium">{project.name}</div>
                    <div className="text-xs opacity-80">Slots: {project.amsSlots}</div>
                  </button>
                </li>
              ))}
              {state.projects.length === 0 && <li className="text-sm text-slate-500">No projects yet.</li>}
            </ul>
          </aside>

          <div className="grid gap-6 lg:col-span-3">
            {!selectedProject && (
              <section className="rounded-xl bg-white p-6 shadow">
                <p className="text-sm text-slate-600">Create and select a project to manage colors, plates, and plan swaps.</p>
              </section>
            )}

            {selectedProject && (
              <>
                <section className="rounded-xl bg-white p-6 shadow">
                  <h2 className="text-lg font-semibold">Project: {selectedProject.name}</h2>
                  <p className="mt-1 text-sm text-slate-600">AMS slots: {selectedProject.amsSlots}</p>
                  <div className="mt-4 grid gap-3 md:max-w-2xl md:grid-cols-2">
                    <label className="grid gap-1 text-sm font-medium">
                      Edit project name
                      <input
                        className="rounded-md border border-slate-300 px-3 py-2 text-sm font-normal"
                        value={projectNameDraft}
                        onChange={(e) => setProjectNameDraft(e.target.value)}
                        onBlur={commitProjectSettings}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            commitProjectSettings();
                          }
                        }}
                      />
                    </label>
                    <label className="grid gap-1 text-sm font-medium">
                      Edit AMS slots
                      <input
                        type="number"
                        min={1}
                        className="rounded-md border border-slate-300 px-3 py-2 text-sm font-normal"
                        value={projectSlotsDraft}
                        onChange={(e) => setProjectSlotsDraft(e.target.value)}
                        onBlur={commitProjectSettings}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            commitProjectSettings();
                          }
                        }}
                      />
                    </label>
                  </div>

                  <div className="mt-6 grid gap-6 md:grid-cols-2">
                    <div>
                      <h3 className="text-base font-semibold">Add Filament Colors</h3>
                      <form className="mt-3 flex gap-2" onSubmit={addColor}>
                        <input
                          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
                          placeholder="Matte Black"
                          value={newColorName}
                          onChange={(e) => setNewColorName(e.target.value)}
                        />
                        <button
                          type="submit"
                          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                        >
                          Add
                        </button>
                      </form>

                      <ul className="mt-3 space-y-1">
                        {sortedProjectColors.map((color) => (
                          <li
                            key={color.id}
                            className="flex items-center justify-between gap-2 rounded border border-slate-200 px-3 py-2 text-sm"
                          >
                            <span>{color.name}</span>
                            {!usedColorIds.has(color.id) && (
                              <button
                                type="button"
                                className="rounded border border-rose-300 px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                                onClick={() => removeColor(color.id)}
                              >
                                Remove
                              </button>
                            )}
                          </li>
                        ))}
                        {selectedProject.colors.length === 0 && (
                          <li className="text-sm text-slate-500">No colors added yet.</li>
                        )}
                      </ul>
                    </div>

                    <div>
                      <h3 className="text-base font-semibold">Add Plate</h3>
                      <form className="mt-3 grid gap-3" onSubmit={addPlate}>
                        <input
                          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
                          placeholder="Plate A"
                          value={newPlateName}
                          onChange={(e) => setNewPlateName(e.target.value)}
                        />
                        <label className="grid gap-2 text-sm font-medium">
                          Estimated print time (minutes)
                          <input
                            type="number"
                            min={0}
                            className="rounded-md border border-slate-300 px-3 py-2 text-sm font-normal"
                            value={newPlateMinutes}
                            onChange={(e) => setNewPlateMinutes(e.target.value)}
                          />
                        </label>
                        <div className="rounded-md border border-slate-200 p-3">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Colors on this plate</p>
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            {sortedProjectColors.map((color) => (
                              <label key={color.id} className="flex items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  checked={newPlateColors.includes(color.id)}
                                  onChange={() => togglePlateColor(color.id)}
                                />
                                {color.name}
                              </label>
                            ))}
                            {selectedProject.colors.length === 0 && (
                              <p className="text-sm text-slate-500">Add colors first.</p>
                            )}
                          </div>
                        </div>
                        <button
                          type="submit"
                          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                        >
                          Add plate
                        </button>
                      </form>
                    </div>
                  </div>
                </section>

                <section className="rounded-xl bg-white p-6 shadow">
                  <h2 className="text-lg font-semibold">Plates</h2>
                  <div className="mt-4 space-y-4">
                    {activePlates.map((plate) => (
                      <article key={plate.id} className="rounded-lg border border-slate-200 p-4">
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                          <div className="w-full">
                            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
                              <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                                Plate name
                                <input
                                  className="rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-900"
                                  value={plateNameDrafts[plate.id] ?? plate.name}
                                  onChange={(e) => handlePlateNameDraftChange(plate.id, e.target.value)}
                                  onBlur={() => commitPlateNameDraft(plate.id)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      commitPlateNameDraft(plate.id);
                                    }
                                  }}
                                />
                              </label>
                              <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                                Est. print time (min)
                                <input
                                  type="number"
                                  min={0}
                                  className="rounded-md border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900"
                                  value={
                                    plateMinuteDrafts[plate.id] ??
                                    String(Number(plate.printMinutes) > 0 ? plate.printMinutes : 0)
                                  }
                                  onChange={(e) => handlePlateMinutesDraftChange(plate.id, e.target.value)}
                                  onBlur={() => commitPlateMinutesDraft(plate.id)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      commitPlateMinutesDraft(plate.id);
                                    }
                                  }}
                                />
                              </label>
                            </div>
                          </div>
                          <div className="flex flex-col gap-2">
                            {plate.printing && (
                              <p className="rounded-md bg-indigo-700 px-3 py-1.5 text-center text-xs font-semibold text-white">
                                Printing now
                              </p>
                            )}
                            {!plate.printing && !hasPrintingPlate && (
                              <button
                                type="button"
                                onClick={() => togglePrinting(plate.id)}
                                className="rounded-md border border-indigo-300 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
                              >
                                Mark printing
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => togglePrinted(plate.id)}
                              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
                            >
                              Mark printed
                            </button>
                          </div>
                        </div>

                        <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Select colors used on this plate
                        </p>

                        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          {colorsForPlate(plate).map((color) => (
                            <label key={color.id} className="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={plate.colorIds.includes(color.id)}
                                onChange={() => toggleExistingPlateColor(plate.id, color.id)}
                              />
                              {color.name}
                            </label>
                          ))}
                        </div>
                      </article>
                    ))}

                    {activePlates.length === 0 && <p className="text-sm text-slate-500">No pending plates.</p>}
                  </div>

                  <div className="mt-8 border-t border-slate-200 pt-6">
                    <h3 className="text-base font-semibold">Completed Plates</h3>
                    <div className="mt-3 space-y-2">
                      {completedPlates.map((plate) => (
                        <div key={plate.id} className="flex items-center justify-between rounded border border-slate-200 px-3 py-2">
                          <div>
                            <p className="text-sm font-medium">{plate.name}</p>
                            <p className="text-xs text-slate-500">
                              {Number(plate.printMinutes) > 0 ? `${plate.printMinutes} min` : '0 min'}
                            </p>
                            <p className="text-xs text-slate-500">
                              {plate.colorIds.map((id) => colorNameById.get(id)).filter(Boolean).join(', ') || 'No colors selected'}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => togglePrinted(plate.id)}
                            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-100"
                          >
                            Mark unprinted
                          </button>
                        </div>
                      ))}

                      {completedPlates.length === 0 && <p className="text-sm text-slate-500">No completed plates yet.</p>}
                    </div>
                  </div>
                </section>

                <section className="rounded-xl bg-white p-6 shadow">
                  <h2 className="text-lg font-semibold">Plan</h2>
                  <p className="mt-1 text-sm text-slate-600">
                    Choose current colors loaded in AMS ({currentAms.length}/{selectedProject.amsSlots}).
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <label htmlFor="plan-sort" className="text-sm font-medium text-slate-700">
                      Print time sort
                    </label>
                    <select
                      id="plan-sort"
                      className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                      value={planTimeSortOrder}
                      onChange={(e) => setPlanTimeSortOrder(e.target.value)}
                    >
                      <option value="asc">Ascending</option>
                      <option value="desc">Descending</option>
                    </select>
                    <p className="text-xs text-slate-500">
                      Applies only when candidate plates have the same minimum swap count.
                    </p>
                  </div>

                  <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {sortedProjectColors.map((color) => (
                      <label key={color.id} className="flex items-center gap-2 rounded border border-slate-200 px-3 py-2 text-sm">
                        <input
                          type="checkbox"
                          checked={currentAms.includes(color.id)}
                          onChange={() => togglePlanColor(color.id)}
                        />
                        {color.name}
                      </label>
                    ))}
                  </div>

                  {planner.error && <p className="mt-4 rounded bg-rose-100 px-3 py-2 text-sm text-rose-800">{planner.error}</p>}

                  {!planner.error && (
                    <>
                      <p className="mt-4 text-sm font-semibold">Estimated swaps: {planner.totalSwaps}</p>
                      <ol className="mt-3 space-y-3">
                        {planner.steps.map((step, index) => (
                          <li
                            key={step.plateId}
                            className={`rounded border p-3 ${
                              step.requiresPauseAndFilamentSwap
                                ? 'border-rose-500'
                                : printingPlateIds.has(step.plateId)
                                  ? 'border-indigo-600'
                                  : 'border-slate-200'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-4">
                              <div>
                                <p className="text-sm font-semibold">
                                  {index + 1}. {step.plateName}
                                  {printingPlateIds.has(step.plateId) && (
                                    <span className="ml-2 text-xs font-semibold text-indigo-700">Printing now</span>
                                  )}
                                  {!printingPlateIds.has(step.plateId) && !hasPrintingPlate && (
                                    <button
                                      type="button"
                                      className="ml-2 text-xs font-semibold text-sky-700 underline hover:text-sky-600"
                                      onClick={() => togglePrinting(step.plateId)}
                                    >
                                      Mark Printing
                                    </button>
                                  )}
                                </p>
                                <p className="text-xs text-slate-500">
                                  Required: {step.required.map((id) => colorNameById.get(id)).filter(Boolean).join(', ') || 'None'}
                                </p>
                                <p className="text-xs text-slate-500">Estimated time: {step.printMinutes} min</p>
                              </div>
                              <div className="text-right text-xs">
                                <p className="font-semibold">Swaps: {step.swaps}</p>
                              </div>
                            </div>
                            <p className="mt-2 text-xs text-slate-500">
                              AMS after step: {step.after.map((id) => colorNameById.get(id)).filter(Boolean).join(', ') || 'None'}
                            </p>
                            {step.swaps > 0 && (
                              <p className="mt-1 text-xs text-slate-600">
                                Swap out: {step.swapOut.map((id) => colorNameById.get(id)).filter(Boolean).join(', ') || 'None'} | Swap in:{' '}
                                {step.swapIn.map((id) => colorNameById.get(id)).filter(Boolean).join(', ') || 'None'}
                              </p>
                            )}
                            {step.requiresPauseAndFilamentSwap && (
                              <p className="mt-2 rounded bg-rose-100 px-2 py-1 text-xs font-semibold text-rose-800">
                                Requires Pause and Filament Swap
                              </p>
                            )}
                          </li>
                        ))}
                        {planner.steps.length === 0 && <li className="text-sm text-slate-500">No remaining plates to plan.</li>}
                      </ol>
                    </>
                  )}
                </section>
              </>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

export default App;
