add_executable(daq_web_bridge bridge.cpp)
target_link_libraries(daq_web_bridge PRIVATE daq::opendaq rapidjson)
target_compile_features(daq_web_bridge PRIVATE cxx_std_17)

if (OPENDAQ_ENABLE_TESTS AND DAQMODULES_REF_DEVICE_MODULE AND DAQMODULES_REF_FB_MODULE)
    find_package(Python3 COMPONENTS Interpreter QUIET)
    if (Python3_Interpreter_FOUND)
        add_test(NAME test_daq_web
            COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_workstation.py
                --bridge $<TARGET_FILE:daq_web_bridge>
                --modules $<TARGET_FILE_DIR:daq_web_bridge>)
        set_tests_properties(test_daq_web PROPERTIES TIMEOUT 180)
        if (Python3_VERSION VERSION_GREATER_EQUAL "3.12")
            add_test(NAME test_daq_web_boost_bootstrap
                COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_build_bootstrap.py)
        endif()
    endif()
endif()
