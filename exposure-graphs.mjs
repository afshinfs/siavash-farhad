export const exposureGraphs = {
  "population": {
    "expression": {
      "result": "0",
      "values": {
        "0": {
          "functionInvocationValue": {
            "functionName": "Image.unmask",
            "arguments": {
              "input": {
                "functionInvocationValue": {
                  "functionName": "Image.toFloat",
                  "arguments": {
                    "value": {
                      "functionInvocationValue": {
                        "functionName": "Image.clip",
                        "arguments": {
                          "geometry": {
                            "functionInvocationValue": {
                              "functionName": "GeometryConstructors.Rectangle",
                              "arguments": {
                                "coordinates": {
                                  "constantValue": [
                                    12.345601,
                                    23.456702,
                                    34.567803,
                                    45.678904
                                  ]
                                },
                                "geodesic": {
                                  "constantValue": false
                                }
                              }
                            }
                          },
                          "input": {
                            "functionInvocationValue": {
                              "functionName": "Image.rename",
                              "arguments": {
                                "input": {
                                  "functionInvocationValue": {
                                    "functionName": "Image.multiply",
                                    "arguments": {
                                      "image1": {
                                        "functionInvocationValue": {
                                          "functionName": "Image.select",
                                          "arguments": {
                                            "bandSelectors": {
                                              "constantValue": [
                                                "population_count"
                                              ]
                                            },
                                            "input": {
                                              "functionInvocationValue": {
                                                "functionName": "Image.load",
                                                "arguments": {
                                                  "id": {
                                                    "constantValue": "__POP_ASSET__"
                                                  }
                                                }
                                              }
                                            }
                                          }
                                        }
                                      },
                                      "image2": {
                                        "functionInvocationValue": {
                                          "functionName": "Image.constant",
                                          "arguments": {
                                            "value": {
                                              "constantValue": 100
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                },
                                "names": {
                                  "constantValue": [
                                    "population_density"
                                  ]
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              },
              "sameFootprint": {
                "constantValue": false
              },
              "value": {
                "functionInvocationValue": {
                  "functionName": "Image.constant",
                  "arguments": {
                    "value": {
                      "constantValue": -9999
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "bands": [
      "population_density"
    ]
  },
  "builtup": {
    "expression": {
      "result": "0",
      "values": {
        "0": {
          "functionInvocationValue": {
            "functionName": "Image.unmask",
            "arguments": {
              "input": {
                "functionInvocationValue": {
                  "functionName": "Image.toFloat",
                  "arguments": {
                    "value": {
                      "functionInvocationValue": {
                        "functionName": "Image.clip",
                        "arguments": {
                          "geometry": {
                            "functionInvocationValue": {
                              "functionName": "GeometryConstructors.Rectangle",
                              "arguments": {
                                "coordinates": {
                                  "constantValue": [
                                    12.345601,
                                    23.456702,
                                    34.567803,
                                    45.678904
                                  ]
                                },
                                "geodesic": {
                                  "constantValue": false
                                }
                              }
                            }
                          },
                          "input": {
                            "functionInvocationValue": {
                              "functionName": "Image.rename",
                              "arguments": {
                                "input": {
                                  "functionInvocationValue": {
                                    "functionName": "Image.divide",
                                    "arguments": {
                                      "image1": {
                                        "functionInvocationValue": {
                                          "functionName": "Image.select",
                                          "arguments": {
                                            "bandSelectors": {
                                              "constantValue": [
                                                "built_surface"
                                              ]
                                            },
                                            "input": {
                                              "functionInvocationValue": {
                                                "functionName": "Image.load",
                                                "arguments": {
                                                  "id": {
                                                    "constantValue": "__BUILT_ASSET__"
                                                  }
                                                }
                                              }
                                            }
                                          }
                                        }
                                      },
                                      "image2": {
                                        "functionInvocationValue": {
                                          "functionName": "Image.constant",
                                          "arguments": {
                                            "value": {
                                              "constantValue": 10000
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                },
                                "names": {
                                  "constantValue": [
                                    "builtup_fraction"
                                  ]
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              },
              "sameFootprint": {
                "constantValue": false
              },
              "value": {
                "functionInvocationValue": {
                  "functionName": "Image.constant",
                  "arguments": {
                    "value": {
                      "constantValue": -9999
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "bands": [
      "builtup_fraction"
    ]
  },
  "proxy": {
    "expression": {
      "result": "0",
      "values": {
        "0": {
          "functionInvocationValue": {
            "functionName": "Image.unmask",
            "arguments": {
              "input": {
                "functionInvocationValue": {
                  "functionName": "Image.toFloat",
                  "arguments": {
                    "value": {
                      "functionInvocationValue": {
                        "functionName": "Image.clip",
                        "arguments": {
                          "geometry": {
                            "functionInvocationValue": {
                              "functionName": "GeometryConstructors.Rectangle",
                              "arguments": {
                                "coordinates": {
                                  "constantValue": [
                                    12.345601,
                                    23.456702,
                                    34.567803,
                                    45.678904
                                  ]
                                },
                                "geodesic": {
                                  "constantValue": false
                                }
                              }
                            }
                          },
                          "input": {
                            "functionInvocationValue": {
                              "functionName": "Image.rename",
                              "arguments": {
                                "input": {
                                  "functionInvocationValue": {
                                    "functionName": "Image.reproject",
                                    "arguments": {
                                      "crs": {
                                        "functionInvocationValue": {
                                          "functionName": "Projection",
                                          "arguments": {
                                            "crs": {
                                              "constantValue": "__EXPOSURE_CRS__"
                                            },
                                            "transform": {
                                              "constantValue": [
                                                101.0101,
                                                0,
                                                102.0102,
                                                0,
                                                -103.0103,
                                                104.0104
                                              ]
                                            }
                                          }
                                        }
                                      },
                                      "image": {
                                        "functionInvocationValue": {
                                          "functionName": "Image.reduceResolution",
                                          "arguments": {
                                            "bestEffort": {
                                              "constantValue": false
                                            },
                                            "image": {
                                              "functionInvocationValue": {
                                                "functionName": "Image.gt",
                                                "arguments": {
                                                  "image1": {
                                                    "functionInvocationValue": {
                                                      "functionName": "Image.select",
                                                      "arguments": {
                                                        "bandSelectors": {
                                                          "constantValue": [
                                                            "built_surface"
                                                          ]
                                                        },
                                                        "input": {
                                                          "functionInvocationValue": {
                                                            "functionName": "Image.load",
                                                            "arguments": {
                                                              "id": {
                                                                "constantValue": "JRC/GHSL/P2023A/GHS_BUILT_S_10m/2018"
                                                              }
                                                            }
                                                          }
                                                        }
                                                      }
                                                    }
                                                  },
                                                  "image2": {
                                                    "functionInvocationValue": {
                                                      "functionName": "Image.constant",
                                                      "arguments": {
                                                        "value": {
                                                          "constantValue": 0
                                                        }
                                                      }
                                                    }
                                                  }
                                                }
                                              }
                                            },
                                            "maxPixels": {
                                              "constantValue": 1024
                                            },
                                            "reducer": {
                                              "functionInvocationValue": {
                                                "functionName": "Reducer.max",
                                                "arguments": {}
                                              }
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                },
                                "names": {
                                  "constantValue": [
                                    "building_presence_proxy"
                                  ]
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              },
              "sameFootprint": {
                "constantValue": false
              },
              "value": {
                "functionInvocationValue": {
                  "functionName": "Image.constant",
                  "arguments": {
                    "value": {
                      "constantValue": -9999
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "bands": [
      "building_presence_proxy"
    ]
  },
  "footprints": {
    "expression": {
      "result": "0",
      "values": {
        "1": {
          "functionInvocationValue": {
            "functionName": "GeometryConstructors.Rectangle",
            "arguments": {
              "coordinates": {
                "constantValue": [
                  12.345601,
                  23.456702,
                  34.567803,
                  45.678904
                ]
              },
              "geodesic": {
                "constantValue": false
              }
            }
          }
        },
        "0": {
          "functionInvocationValue": {
            "functionName": "Image.unmask",
            "arguments": {
              "input": {
                "functionInvocationValue": {
                  "functionName": "Image.toFloat",
                  "arguments": {
                    "value": {
                      "functionInvocationValue": {
                        "functionName": "Image.clip",
                        "arguments": {
                          "geometry": {
                            "valueReference": "1"
                          },
                          "input": {
                            "functionInvocationValue": {
                              "functionName": "Image.rename",
                              "arguments": {
                                "input": {
                                  "functionInvocationValue": {
                                    "functionName": "Image.reproject",
                                    "arguments": {
                                      "crs": {
                                        "functionInvocationValue": {
                                          "functionName": "Projection",
                                          "arguments": {
                                            "crs": {
                                              "constantValue": "__EXPOSURE_CRS__"
                                            },
                                            "transform": {
                                              "constantValue": [
                                                101.0101,
                                                0,
                                                102.0102,
                                                0,
                                                -103.0103,
                                                104.0104
                                              ]
                                            }
                                          }
                                        }
                                      },
                                      "image": {
                                        "functionInvocationValue": {
                                          "functionName": "Image.paint",
                                          "arguments": {
                                            "color": {
                                              "constantValue": 1
                                            },
                                            "featureCollection": {
                                              "functionInvocationValue": {
                                                "functionName": "Collection.filter",
                                                "arguments": {
                                                  "collection": {
                                                    "functionInvocationValue": {
                                                      "functionName": "Collection.loadTable",
                                                      "arguments": {
                                                        "tableId": {
                                                          "constantValue": "GOOGLE/Research/open-buildings/v3/polygons"
                                                        }
                                                      }
                                                    }
                                                  },
                                                  "filter": {
                                                    "functionInvocationValue": {
                                                      "functionName": "Filter.intersects",
                                                      "arguments": {
                                                        "leftField": {
                                                          "constantValue": ".all"
                                                        },
                                                        "rightValue": {
                                                          "functionInvocationValue": {
                                                            "functionName": "Feature",
                                                            "arguments": {
                                                              "geometry": {
                                                                "valueReference": "1"
                                                              }
                                                            }
                                                          }
                                                        }
                                                      }
                                                    }
                                                  }
                                                }
                                              }
                                            },
                                            "image": {
                                              "functionInvocationValue": {
                                                "functionName": "Image.toByte",
                                                "arguments": {
                                                  "value": {
                                                    "functionInvocationValue": {
                                                      "functionName": "Image.constant",
                                                      "arguments": {
                                                        "value": {
                                                          "constantValue": 0
                                                        }
                                                      }
                                                    }
                                                  }
                                                }
                                              }
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                },
                                "names": {
                                  "constantValue": [
                                    "building_footprint_mask"
                                  ]
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              },
              "sameFootprint": {
                "constantValue": false
              },
              "value": {
                "functionInvocationValue": {
                  "functionName": "Image.constant",
                  "arguments": {
                    "value": {
                      "constantValue": -9999
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "bands": [
      "building_footprint_mask"
    ],
    "audit": {
      "result": "0",
      "values": {
        "0": {
          "dictionaryValue": {
            "values": {
              "features": {
                "functionInvocationValue": {
                  "functionName": "Collection.size",
                  "arguments": {
                    "collection": {
                      "functionInvocationValue": {
                        "functionName": "Collection.filter",
                        "arguments": {
                          "collection": {
                            "functionInvocationValue": {
                              "functionName": "Collection.loadTable",
                              "arguments": {
                                "tableId": {
                                  "constantValue": "GOOGLE/Research/open-buildings/v3/polygons"
                                }
                              }
                            }
                          },
                          "filter": {
                            "functionInvocationValue": {
                              "functionName": "Filter.intersects",
                              "arguments": {
                                "leftField": {
                                  "constantValue": ".all"
                                },
                                "rightValue": {
                                  "functionInvocationValue": {
                                    "functionName": "Feature",
                                    "arguments": {
                                      "geometry": {
                                        "functionInvocationValue": {
                                          "functionName": "GeometryConstructors.Rectangle",
                                          "arguments": {
                                            "coordinates": {
                                              "constantValue": [
                                                12.345601,
                                                23.456702,
                                                34.567803,
                                                45.678904
                                              ]
                                            },
                                            "geodesic": {
                                              "constantValue": false
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  "nightlights": {
    "expression": {
      "result": "0",
      "values": {
        "2": {
          "constantValue": [
            "avg_rad"
          ]
        },
        "3": {
          "functionInvocationValue": {
            "functionName": "Collection.filter",
            "arguments": {
              "collection": {
                "functionInvocationValue": {
                  "functionName": "ImageCollection.load",
                  "arguments": {
                    "id": {
                      "constantValue": "NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG"
                    }
                  }
                }
              },
              "filter": {
                "functionInvocationValue": {
                  "functionName": "Filter.dateRangeContains",
                  "arguments": {
                    "leftValue": {
                      "functionInvocationValue": {
                        "functionName": "DateRange",
                        "arguments": {
                          "end": {
                            "constantValue": "__LIGHT_END__"
                          },
                          "start": {
                            "constantValue": "__LIGHT_START__"
                          }
                        }
                      }
                    },
                    "rightField": {
                      "constantValue": "system:time_start"
                    }
                  }
                }
              }
            }
          }
        },
        "1": {
          "functionInvocationValue": {
            "functionName": "Image.projection",
            "arguments": {
              "image": {
                "functionInvocationValue": {
                  "functionName": "Image.select",
                  "arguments": {
                    "bandSelectors": {
                      "valueReference": "2"
                    },
                    "input": {
                      "functionInvocationValue": {
                        "functionName": "Collection.first",
                        "arguments": {
                          "collection": {
                            "valueReference": "3"
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        "6": {
          "functionInvocationValue": {
            "functionName": "Image.constant",
            "arguments": {
              "value": {
                "constantValue": 0
              }
            }
          }
        },
        "5": {
          "functionInvocationValue": {
            "functionName": "Image.updateMask",
            "arguments": {
              "image": {
                "functionInvocationValue": {
                  "functionName": "Image.select",
                  "arguments": {
                    "bandSelectors": {
                      "valueReference": "2"
                    },
                    "input": {
                      "argumentReference": "_MAPPING_VAR_0_0"
                    }
                  }
                }
              },
              "mask": {
                "functionInvocationValue": {
                  "functionName": "Image.gt",
                  "arguments": {
                    "image1": {
                      "functionInvocationValue": {
                        "functionName": "Image.select",
                        "arguments": {
                          "bandSelectors": {
                            "constantValue": [
                              "cf_cvg"
                            ]
                          },
                          "input": {
                            "argumentReference": "_MAPPING_VAR_0_0"
                          }
                        }
                      }
                    },
                    "image2": {
                      "valueReference": "6"
                    }
                  }
                }
              }
            }
          }
        },
        "4": {
          "functionInvocationValue": {
            "functionName": "Collection.map",
            "arguments": {
              "baseAlgorithm": {
                "functionDefinitionValue": {
                  "argumentNames": [
                    "_MAPPING_VAR_0_0"
                  ],
                  "body": "5"
                }
              },
              "collection": {
                "valueReference": "3"
              }
            }
          }
        },
        "0": {
          "functionInvocationValue": {
            "functionName": "Image.unmask",
            "arguments": {
              "input": {
                "functionInvocationValue": {
                  "functionName": "Image.toFloat",
                  "arguments": {
                    "value": {
                      "functionInvocationValue": {
                        "functionName": "Image.clip",
                        "arguments": {
                          "geometry": {
                            "functionInvocationValue": {
                              "functionName": "GeometryConstructors.Rectangle",
                              "arguments": {
                                "coordinates": {
                                  "constantValue": [
                                    12.345601,
                                    23.456702,
                                    34.567803,
                                    45.678904
                                  ]
                                },
                                "geodesic": {
                                  "constantValue": false
                                }
                              }
                            }
                          },
                          "input": {
                            "functionInvocationValue": {
                              "functionName": "Image.rename",
                              "arguments": {
                                "input": {
                                  "functionInvocationValue": {
                                    "functionName": "Image.addBands",
                                    "arguments": {
                                      "dstImg": {
                                        "functionInvocationValue": {
                                          "functionName": "Image.resample",
                                          "arguments": {
                                            "image": {
                                              "functionInvocationValue": {
                                                "functionName": "Image.setDefaultProjection",
                                                "arguments": {
                                                  "crs": {
                                                    "valueReference": "1"
                                                  },
                                                  "image": {
                                                    "functionInvocationValue": {
                                                      "functionName": "reduce.mean",
                                                      "arguments": {
                                                        "collection": {
                                                          "valueReference": "4"
                                                        }
                                                      }
                                                    }
                                                  }
                                                }
                                              }
                                            },
                                            "mode": {
                                              "constantValue": "bilinear"
                                            }
                                          }
                                        }
                                      },
                                      "srcImg": {
                                        "functionInvocationValue": {
                                          "functionName": "Image.setDefaultProjection",
                                          "arguments": {
                                            "crs": {
                                              "valueReference": "1"
                                            },
                                            "image": {
                                              "functionInvocationValue": {
                                                "functionName": "Image.unmask",
                                                "arguments": {
                                                  "input": {
                                                    "functionInvocationValue": {
                                                      "functionName": "reduce.count",
                                                      "arguments": {
                                                        "collection": {
                                                          "valueReference": "4"
                                                        }
                                                      }
                                                    }
                                                  },
                                                  "value": {
                                                    "valueReference": "6"
                                                  }
                                                }
                                              }
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                },
                                "names": {
                                  "constantValue": [
                                    "nightlights",
                                    "nightlights_months"
                                  ]
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              },
              "sameFootprint": {
                "constantValue": false
              },
              "value": {
                "functionInvocationValue": {
                  "functionName": "Image.constant",
                  "arguments": {
                    "value": {
                      "constantValue": -9999
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "bands": [
      "nightlights",
      "nightlights_months"
    ],
    "audit": {
      "result": "0",
      "values": {
        "0": {
          "dictionaryValue": {
            "values": {
              "months": {
                "functionInvocationValue": {
                  "functionName": "Collection.size",
                  "arguments": {
                    "collection": {
                      "functionInvocationValue": {
                        "functionName": "Collection.filter",
                        "arguments": {
                          "collection": {
                            "functionInvocationValue": {
                              "functionName": "ImageCollection.load",
                              "arguments": {
                                "id": {
                                  "constantValue": "NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG"
                                }
                              }
                            }
                          },
                          "filter": {
                            "functionInvocationValue": {
                              "functionName": "Filter.dateRangeContains",
                              "arguments": {
                                "leftValue": {
                                  "functionInvocationValue": {
                                    "functionName": "DateRange",
                                    "arguments": {
                                      "end": {
                                        "constantValue": "__LIGHT_END__"
                                      },
                                      "start": {
                                        "constantValue": "__LIGHT_START__"
                                      }
                                    }
                                  }
                                },
                                "rightField": {
                                  "constantValue": "system:time_start"
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
};
