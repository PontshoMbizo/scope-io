import SimulatorEmbed from "@/components/SimulatorEmbed";

export const metadata = {
  title: "Block Diagrams — scope.io",
  description: "Simulink-style block-diagram simulator (fulgurlab, Scilab/Xcos)",
};

export default function BlocksToolPage() {
  return (
    <SimulatorEmbed
      src={process.env.NEXT_PUBLIC_FULGURLAB_URL}
      title="Block Diagrams · fulgurlab"
      envVar="NEXT_PUBLIC_FULGURLAB_URL"
      accent="text-cyan-600"
      hideHeader={true}
    />
  );
}
