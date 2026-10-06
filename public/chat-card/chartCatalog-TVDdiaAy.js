var e=`<ChartContainer config={{ visitors: { label: "Visitors", color: "var(--chart-1)" } }} aria-label="Monthly visitors" description="Visitors increased from 120 in January to 180 in March.">
  <BarChart accessibilityLayer data={[{ month: "Jan", visitors: 120 }, { month: "Feb", visitors: 160 }, { month: "Mar", visitors: 180 }]}>
    <CartesianGrid vertical={false} />
    <XAxis dataKey="month" tickLine={false} axisLine={false} />
    <YAxis width={40} tickLine={false} axisLine={false} />
    <ChartTooltip content={<ChartTooltipContent />} />
    <ChartLegend content={<ChartLegendContent />} />
    <Bar dataKey="visitors" fill="var(--color-visitors)" radius={4} isAnimationActive={false} />
  </BarChart>
</ChartContainer>`,t=e.replaceAll(`BarChart`,`LineChart`).replace(`<Bar dataKey="visitors" fill="var(--color-visitors)" radius={4}`,`<Line type="monotone" dataKey="visitors" stroke="var(--color-visitors)" strokeWidth={2}`),n=e.replaceAll(`BarChart`,`AreaChart`).replace(`<Bar dataKey="visitors" fill="var(--color-visitors)" radius={4}`,`<Area type="monotone" dataKey="visitors" fill="var(--color-visitors)" fillOpacity={0.2} stroke="var(--color-visitors)"`),r=`<ChartContainer config={{ apples: { label: "Apples", color: "var(--chart-1)" }, pears: { label: "Pears", color: "var(--chart-2)" }, berries: { label: "Berries", color: "var(--chart-3)" } }} aria-label="Fruit orders" description="Apples: 40 orders. Pears: 35. Berries: 25.">
  <PieChart accessibilityLayer>
    <ChartTooltip content={<ChartTooltipContent nameKey="fruit" hideLabel />} />
    <ChartLegend content={<ChartLegendContent nameKey="fruit" />} />
    <Pie data={[{ fruit: "apples", orders: 40 }, { fruit: "pears", orders: 35 }, { fruit: "berries", orders: 25 }]} dataKey="orders" nameKey="fruit" innerRadius={40} isAnimationActive={false}>
      <Cell fill="var(--color-apples)" />
      <Cell fill="var(--color-pears)" />
      <Cell fill="var(--color-berries)" />
    </Pie>
  </PieChart>
</ChartContainer>`,i=`<ChartContainer config={{ score: { label: "Score", color: "var(--chart-1)" } }} aria-label="Review scores" description="Clarity: 80. Coverage: 65. Usability: 90.">
  <RadarChart accessibilityLayer data={[{ metric: "Clarity", score: 80 }, { metric: "Coverage", score: 65 }, { metric: "Usability", score: 90 }]}>
    <PolarGrid />
    <PolarAngleAxis dataKey="metric" />
    <PolarRadiusAxis domain={[0, 100]} />
    <ChartTooltip content={<ChartTooltipContent />} />
    <Radar dataKey="score" stroke="var(--color-score)" fill="var(--color-score)" fillOpacity={0.2} isAnimationActive={false} />
  </RadarChart>
</ChartContainer>`,a=`<ChartContainer config={{ done: { label: "Complete", color: "var(--chart-1)" } }} aria-label="Review completion" description="75 percent of the review is complete.">
  <RadialBarChart accessibilityLayer data={[{ name: "done", value: 75, fill: "var(--color-done)" }]} innerRadius="50%" outerRadius="90%" startAngle={180} endAngle={0}>
    <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
    <ChartTooltip content={<ChartTooltipContent nameKey="name" hideLabel />} />
    <RadialBar dataKey="value" background isAnimationActive={false} />
  </RadialBarChart>
</ChartContainer>`,o=`<ChartContainer config={{ samples: { label: "Samples", color: "var(--chart-1)" } }} aria-label="Study time and score" description="One hour: 55 points. Two hours: 70. Three hours: 85.">
  <ScatterChart accessibilityLayer margin={{ top: 12, right: 12, bottom: 12, left: 0 }}>
    <CartesianGrid />
    <XAxis type="number" dataKey="hours" name="Study time" unit=" h" />
    <YAxis type="number" dataKey="score" name="Score" width={40} />
    <ZAxis type="number" dataKey="size" range={[60, 120]} />
    <ChartTooltip content={<ChartTooltipContent />} />
    <Scatter name="samples" data={[{ hours: 1, score: 55, size: 1 }, { hours: 2, score: 70, size: 2 }, { hours: 3, score: 85, size: 3 }]} fill="var(--color-samples)" isAnimationActive={false} />
  </ScatterChart>
</ChartContainer>`;function s(e,t,n,r=`${n}$0`){return{name:e,description:t,props:[],template:n,snippet:r,editableProps:!1}}var c=[s(`ChartContainer`,`Responsive shadcn chart with inline config and Recharts children (source-only)`,e),s(`BarChart`,`Recharts bar chart with ordinary inline data`,e),s(`Bar`,`Bar series inside BarChart or ComposedChart; picker inserts a complete chart`,e,'<Bar dataKey="${1:value}" fill="var(--chart-1)" isAnimationActive={false} />$0'),s(`LineChart`,`Recharts line chart with ordinary inline data`,t),s(`Line`,`Line series inside LineChart or ComposedChart; picker inserts a complete chart`,t,'<Line dataKey="${1:value}" stroke="var(--chart-1)" isAnimationActive={false} />$0'),s(`AreaChart`,`Recharts area chart with ordinary inline data`,n),s(`Area`,`Area series inside AreaChart or ComposedChart; picker inserts a complete chart`,n,'<Area dataKey="${1:value}" fill="var(--chart-1)" stroke="var(--chart-1)" isAnimationActive={false} />$0'),s(`PieChart`,`Recharts pie or donut chart with ordinary inline data`,r),s(`Pie`,`Pie series inside PieChart; picker inserts a complete chart`,r),s(`Cell`,`Per-item color inside a Recharts series; picker inserts a complete pie chart`,r,'<Cell fill="var(--chart-${1:1})" />$0'),s(`ChartTooltip`,`Shadcn tooltip inside a chart; picker inserts a complete chart`,e,`<ChartTooltip content={<ChartTooltipContent />} />$0`),s(`ChartTooltipContent`,`Shadcn tooltip content with labels, values and indicators`,e,`<ChartTooltipContent />$0`),s(`ChartLegend`,`Shadcn legend inside a chart; picker inserts a complete chart`,e,`<ChartLegend content={<ChartLegendContent />} />$0`),s(`ChartLegendContent`,`Shadcn legend content using chart config labels`,e,`<ChartLegendContent />$0`),s(`CartesianGrid`,`Cartesian chart grid; picker inserts a complete chart`,e,`<CartesianGrid vertical={false} />$0`),s(`XAxis`,`Chart horizontal axis; picker inserts a complete chart`,e,'<XAxis dataKey="${1:month}" tickLine={false} axisLine={false} />$0'),s(`YAxis`,`Chart vertical axis; picker inserts a complete chart`,e,`<YAxis width={40} tickLine={false} axisLine={false} />$0`),s(`ZAxis`,`Scatter size axis; picker inserts a complete scatter chart`,o,'<ZAxis dataKey="${1:size}" />$0'),s(`Label`,`Axis label; picker inserts a chart containing a labelled axis`,e.replace(`<XAxis dataKey="month" tickLine={false} axisLine={false} />`,`<XAxis dataKey="month" tickLine={false} axisLine={false} height={48}><Label value="Month" position="insideBottom" /></XAxis>`),'<Label value="${1:Axis label}" />$0'),s(`LabelList`,`Series labels; picker inserts a chart with bar values`,e.replace(`radius={4} isAnimationActive={false} />`,`radius={4} isAnimationActive={false}><LabelList dataKey="visitors" position="insideTop" fill="var(--panel)" /></Bar>`),'<LabelList dataKey="${1:value}" position="insideTop" />$0'),s(`ReferenceLine`,`Chart reference line; picker inserts a chart with a target`,e.replace(`    <ChartTooltip`,`    <ReferenceLine y={150} stroke="var(--chart-3)" strokeDasharray="4 4" />
    <ChartTooltip`),'<ReferenceLine y={${1:150}} stroke="var(--chart-3)" />$0'),s(`ComposedChart`,`Combine ordinary Recharts series in one chart`,e.replaceAll(`BarChart`,`ComposedChart`).replace(`  </ComposedChart>`,`    <Line dataKey="visitors" stroke="var(--chart-3)" isAnimationActive={false} />
  </ComposedChart>`)),s(`RadarChart`,`Recharts radar chart with ordinary inline data`,i),s(`Radar`,`Radar series; picker inserts a complete radar chart`,i),s(`PolarGrid`,`Polar chart grid; picker inserts a complete radar chart`,i,`<PolarGrid />$0`),s(`PolarAngleAxis`,`Polar angle axis; picker inserts a complete radar chart`,i,'<PolarAngleAxis dataKey="${1:metric}" />$0'),s(`PolarRadiusAxis`,`Polar radius axis; picker inserts a complete radar chart`,i,`<PolarRadiusAxis domain={[0, 100]} />$0`),s(`RadialBarChart`,`Recharts radial bar chart with ordinary inline data`,a),s(`RadialBar`,`Radial bar series; picker inserts a complete radial chart`,a),s(`ScatterChart`,`Recharts scatter chart with ordinary inline data`,o),s(`Scatter`,`Scatter series; picker inserts a complete scatter chart`,o)];export{c as t};