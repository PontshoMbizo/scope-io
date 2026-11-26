import SimulatorEmbed from "@/components/SimulatorEmbed";

export const metadata = {
  title: "SPICE Circuits — scope.io",
  description: "Schematic capture and ngspice simulation (fulgurspice)",
};

export default function SpiceToolPage() {
  return (
    <SimulatorEmbed
      src={process.env.NEXT_PUBLIC_FULGURSPICE_URL}
      title="SPICE Circuits · fulgurspice"
      envVar="NEXT_PUBLIC_FULGURSPICE_URL"
      accent="text-cyan-600"
      hideHeader={true}
    />
  );
}
