// Types for the parts of mission-package.json the app reads (see schema/marswalk.schema.json).

export interface Position {
  lon: number;
  lat: number;
  elev_m?: number;
}

export interface LegendItem {
  label: string;
  color?: string;
}

export interface Layer {
  id: string;
  title: string;
  sourceId: string;
  dataKind: string;
  coverage?: [number, number, number, number];
  resolution_m?: number;
  access: {
    type: string;
    urlTemplate?: string;
    packagePath?: string;
    minLevel?: number;
    maxLevel?: number;
  };
  display?: { defaultVisible?: boolean; opacity?: number; legend?: LegendItem[] };
  attribution: string;
  caveats?: string[];
}

export interface Stop {
  id: string;
  name: string;
  kind: string;
  position: Position;
  plannedMinutes?: number;
  tasks?: string[];
  objectiveIds?: string[];
  geologicUnit?: string;
  povImageIds?: string[];
  notes?: string;
}

export interface PovImage {
  imageId: string;
  sol: number;
  instrument: string;
  takenUtc?: string;
  urls: { small?: string; medium?: string; large?: string; full?: string; packagePath?: string };
  credit: string;
  caption?: string;
  pointing?: { mastAz_deg?: number; mastEl_deg?: number };
}

export interface Objective {
  id: string;
  title: string;
  question: string;
  whyHumans?: string;
}

export interface Assumption {
  id: string;
  statement: string;
  value?: number;
  unit?: string;
  status: string;
}

export interface RoverWaypoint {
  rmc: string;
  sol: number;
  position: Position;
}

/** An official place name (from the USGS map, R2): where the map prints the label. */
export interface PlaceName {
  name: string;
  position: Position;
  rank?: "major" | "minor";
  sourceId: string;
}

export interface MissionPackage {
  id: string;
  title: string;
  layers: Layer[];
  site: {
    id: string;
    name: string;
    region: string;
    center: Position;
    aoi: [number, number, number, number];
    description?: string;
    base: { kind: string; position: Position; antennaHeight_m?: number };
  };
  objectives: Objective[];
  stops: Stop[];
  povImages: PovImage[];
  roverWaypoints: RoverWaypoint[];
  placeNames?: PlaceName[];
  assumptions: Assumption[];
  sources: { id: string; name: string; credit: string; role: string }[];
}

export function assumption(pkg: MissionPackage, id: string, fallback: number): number {
  const a = pkg.assumptions.find((x) => x.id === id);
  return typeof a?.value === "number" ? a.value : fallback;
}

export function isCloseUp(p: PovImage): boolean {
  return p.instrument.startsWith("SHERLOC") || p.instrument.startsWith("SUPERCAM");
}

export function cameraName(instrument: string): string {
  const names: Record<string, string> = {
    NAVCAM_LEFT: "Navigation camera",
    NAVCAM_RIGHT: "Navigation camera",
    MCZ_LEFT: "Mastcam-Z",
    MCZ_RIGHT: "Mastcam-Z",
    SHERLOC_WATSON: "WATSON close-up camera",
    SUPERCAM_RMI: "SuperCam zoom camera",
    FRONT_HAZCAM_LEFT_A: "Front hazard camera",
  };
  return names[instrument] ?? instrument.replace(/_/g, " ").toLowerCase();
}
