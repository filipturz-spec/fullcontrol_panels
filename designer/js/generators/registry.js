/**
 * Generator Registry
 * Each entry: { type, label, icon, description, defaults }
 * The generate(params, W, H, paper) function lives in each module.
 */
export const GENERATORS = {
  diamond: {
    type:        'diamond',
    label:       'Diamond Grid',
    icon:        '◆',
    description: 'Two crossing wave arrays forming diamonds',
    defaults: {
      cols:         9,      // paths per direction
      amplitude:    38,     // px horizontal deviation
      freqTop:      3.5,    // cycles at top (higher = compressed cells)
      freqBottom:   2.0,    // cycles at bottom (lower = open cells)
      phaseStep:    1.0,    // phase offset multiplier between adjacent paths
      angle:        0,      // overall lean in degrees (0 = symmetric)
      strokeWeight: 2.5,
      color:        '#8B6914',
    },
  },

  zigzag: {
    type:        'zigzag',
    label:       'Zigzag / Triangle',
    icon:        '▲',
    description: 'Straight lines forming triangular lattice',
    defaults: {
      cols:         11,     // number of column positions
      rows:         10,     // number of row divisions
      compress:     0.4,    // 0 = uniform height, >0 = compressed top
      curvature:    0,      // 0 = straight lines, >0 = curved zigzag
      strokeWeight: 2.5,
      color:        '#8B6914',
    },
  },

  ladder: {
    type:        'ladder',
    label:       'Ladder / Barcode',
    icon:        '☰',
    description: 'Parallel verticals with horizontal rungs in zones',
    defaults: {
      cols:         12,
      strokeWeight: 2.5,
      color:        '#8B6914',
      zones: [
        { heightFrac: 0.15, rungs: 14 },
        { heightFrac: 0.15, rungs: 8  },
        { heightFrac: 0.15, rungs: 4  },
        { heightFrac: 0.15, rungs: 2  },
        { heightFrac: 0.40, rungs: 0  },
      ],
    },
  },

  roundedRect: {
    type:        'roundedRect',
    label:       'Rounded Rect Grid',
    icon:        '▢',
    description: 'Grid of rounded rectangles, optionally linked',
    defaults: {
      cols:         5,
      rows:         8,
      gapX:         10,
      gapY:         10,
      cornerRadius: 18,
      linkH:        false,  // horizontal links between cells
      linkV:        false,  // vertical links
      strokeWeight: 3,
      color:        '#7a2a10',
    },
  },
};

export const GENERATOR_ORDER = ['diamond', 'zigzag', 'ladder', 'roundedRect'];
