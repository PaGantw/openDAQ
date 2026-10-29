opendaq_set_cmake_folder_context(TARGET_FOLDER_NAME)

add_subdirectory(applications)
add_subdirectory(modules)

option(OPENDAQ_BUILD_WEB_APP "Build the browser DAQ workstation SDK bridge" OFF)
if (OPENDAQ_BUILD_WEB_APP)
    add_subdirectory(applications/daq_web)
endif()
