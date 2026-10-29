// Line-delimited JSON bridge. stdout is reserved for protocol responses.
#include <opendaq/opendaq.h>
#include <opendaq/reader_factory.h>
#include <opendaq/stream_reader_builder_ptr.h>
#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

using namespace daq;
using J = rapidjson::Value;
using A = rapidjson::Document::AllocatorType;
static J str(const std::string& s, A& a) { return J(s.c_str(), static_cast<rapidjson::SizeType>(s.size()), a); }
static std::string txt(const StringPtr& s) { return s.assigned() ? s.toStdString() : ""; }
static void put(J& o, const char* k, J v, A& a) { o.AddMember(str(k,a), v, a); }
static std::string field(const J& j, const char* k) {
    if (!j.HasMember(k) || !j[k].IsString()) throw std::runtime_error(std::string("Missing string: ")+k);
    return j[k].GetString();
}
static J valueJson(const BaseObjectPtr& v, A& a, int depth=0) {
    if (!v.assigned()) return J();
    if (depth>6) return str(v.toString(),a);
    switch (v.getCoreType()) {
        case ctBool: return J(static_cast<bool>(BoolPtr(v)));
        case ctInt: return J(static_cast<int64_t>(IntPtr(v)));
        case ctFloat: { double n=FloatPtr(v); return std::isfinite(n) ? J(n) : J(); }
        case ctString: return str(txt(v.asPtr<IString>()),a);
        case ctList: { J r(rapidjson::kArrayType); for (const auto& x : v.asPtr<IList>()) r.PushBack(valueJson(x,a,depth+1),a); return r; }
        default: return str(v.toString(),a);
    }
}
class Workstation {
    InstancePtr instance;
    struct Subscription {
        StreamReaderPtr stream;
        PacketReaderPtr packets;
        DataPacketPtr held;
        SizeT offset=0;
        bool domain=false;
        std::string source;
    };
    std::map<std::string, Subscription> readers;
    std::map<std::string, SignalPtr> signals() {
        std::map<std::string,SignalPtr> result;
        for(const auto& s:instance.getSignalsRecursive()) {
            result[txt(s.getGlobalId())]=s;
            auto d=s.getDomainSignal();if(d.assigned())result[txt(d.getGlobalId())]=d;
        }
        return result;
    }
    std::string domainSource(const std::string& id) {
        for(const auto& entry:signals()) {
            auto d=entry.second.getDomainSignal();auto dd=entry.second.getDescriptor();
            if(d.assigned()&&txt(d.getGlobalId())==id&&dd.assigned()&&dd.getDimensions().getCount()==0)return entry.first;
        }
        return "";
    }
    static bool numeric(SampleType t) { return t>=SampleType::Float32 && t<=SampleType::Int64; }
    static double numberAt(const void* p,SampleType t,SizeT i) {
        switch(t) {
#define VALUE_CASE(T,C) case SampleType::T: return static_cast<const C*>(p)[i];
            VALUE_CASE(Float32,float) VALUE_CASE(Float64,double) VALUE_CASE(Int8,int8_t) VALUE_CASE(UInt8,uint8_t)
            VALUE_CASE(Int16,int16_t) VALUE_CASE(UInt16,uint16_t) VALUE_CASE(Int32,int32_t) VALUE_CASE(UInt32,uint32_t)
            VALUE_CASE(Int64,int64_t) VALUE_CASE(UInt64,uint64_t)
#undef VALUE_CASE
            default:throw std::runtime_error("Unsupported numeric sample type");
        }
    }
    static SizeT byteSize(SampleType t) {
        switch(t) {
            case SampleType::Int8:case SampleType::UInt8:return 1;
            case SampleType::Int16:case SampleType::UInt16:return 2;
            case SampleType::Int32:case SampleType::UInt32:case SampleType::Float32:return 4;
            case SampleType::Int64:case SampleType::UInt64:case SampleType::Float64:return 8;
            default:throw std::runtime_error("Unsupported sample representation");
        }
    }
    static void domainMetadata(J& out,const DataDescriptorPtr& dd,A& a) {
        if(!dd.assigned())return;auto r=dd.getTickResolution();
        if(r.assigned()){put(out,"tickNumerator",str(std::to_string(r.getNumerator()),a),a);put(out,"tickDenominator",str(std::to_string(r.getDenominator()),a),a);}
        put(out,"origin",str(txt(dd.getOrigin()),a),a);
    }
    J vectorSamples(Subscription& sub,A& a) {
        J frames(rapidjson::kArrayType);int inspected=0;
        while(frames.Size()<32 && inspected++<128) {
            if(!sub.held.assigned()||sub.offset>=sub.held.getSampleCount()) {
                auto packet=sub.packets.read();if(!packet.assigned())break;
                if(packet.getType()!=PacketType::Data)continue;
                sub.held=packet.asPtr<IDataPacket>();sub.offset=0;
                if(sub.held.getSampleCount()==0)continue;
            }
            auto packet=sub.held;auto dd=packet.getDataDescriptor();auto dims=dd.getDimensions();
            if(dims.getCount()!=1)throw std::runtime_error("Only one-dimensional numeric vectors are supported");
            auto dim=dims[0];SizeT width=dim.getSize();
            if(!width||width>16384)throw std::runtime_error("Vector size must be 1-16384");
            auto type=dd.getSampleType();
            if(packet.getDataSize()<(sub.offset+1)*width*byteSize(type))throw std::runtime_error("Incomplete vector packet");
            auto data=packet.getData();J frame(rapidjson::kObjectType),values(rapidjson::kArrayType),axis(rapidjson::kArrayType);
            auto labels=dim.getLabels();
            for(SizeT i=0;i<width;++i) {
                double value=numberAt(data,type,sub.offset*width+i);values.PushBack(std::isfinite(value)?J(value):J(),a);
                if(labels.assigned()&&i<labels.getCount()&&labels[i].supportsInterface<INumber>())axis.PushBack(J(labels[i].asPtr<INumber>().getFloatValue()),a);
                else axis.PushBack(J(static_cast<double>(i)),a);
            }
            put(frame,"values",std::move(values),a);put(frame,"axis",std::move(axis),a);
            auto unit=dim.getUnit();put(frame,"axisUnit",str(unit.assigned()?txt(unit.getSymbol()):"index",a),a);
            auto dp=packet.getDomainPacket();
            if(dp.assigned()&&sub.offset<dp.getSampleCount()) {
                auto dt=dp.getDataDescriptor().getSampleType();const void* ticks=dp.getData();std::string tick;
                if(dt==SampleType::UInt64)tick=std::to_string(static_cast<const uint64_t*>(ticks)[sub.offset]);
                else if(dt==SampleType::Int64)tick=std::to_string(static_cast<const int64_t*>(ticks)[sub.offset]);
                else throw std::runtime_error("Vector domain must use Int64 or UInt64 ticks");
                put(frame,"tick",str(tick,a),a);domainMetadata(frame,dp.getDataDescriptor(),a);
            }
            ++sub.offset;frames.PushBack(frame,a);
        }
        return frames;
    }

    ComponentPtr component(const std::string& id) {
        if (id==txt(instance.getGlobalId()) || id.empty()) return instance;
        auto c=instance.findComponent(id);
        if (!c.assigned()) throw std::runtime_error("Component no longer exists: "+id);
        return c;
    }
    J node(const ComponentPtr& c, const char* kind, A& a) {
        J n(rapidjson::kObjectType);
        put(n,"id",str(txt(c.getGlobalId()),a),a); put(n,"name",str(txt(c.getName()),a),a);
        put(n,"kind",str(kind,a),a); put(n,"description",str(txt(c.getDescription()),a),a);
        return n;
    }
    void appendDevice(const DevicePtr& dev, J& nodes, A& a) {
        auto n=node(dev,"device",a); auto info=dev.getInfo();
        put(n,"connection",str(txt(info.getConnectionString()),a),a);
        put(n,"serial",str(txt(info.getSerialNumber()),a),a); nodes.PushBack(n,a);
        for (const auto& c:dev.getChannels()) nodes.PushBack(node(c,"channel",a),a);
        for (const auto& sub:dev.getDevices()) appendDevice(sub,nodes,a);
    }
public:
    explicit Workstation(const char* path) {
        auto logger=LoggerWithSinks(List<ILoggerSink>(StdErrLoggerSink()),LogLevel::Warn);
        instance=InstanceFromBuilder(InstanceBuilder().setModulePath(path).setLogger(logger).setDefaultRootDeviceLocalId("daq-web"));
    }
    J run(const J& req,A& a) {
        const auto op=field(req,"op"); J out(rapidjson::kObjectType);
        if(op=="state") {
            put(out,"bridgeVersion",J(2),a);
            put(out,"root",str(txt(instance.getGlobalId()),a),a);
            J nodes(rapidjson::kArrayType); nodes.PushBack(node(instance,"instance",a),a);
            for(const auto& d:instance.getDevices()) appendDevice(d,nodes,a);
            J signals(rapidjson::kArrayType);
            for(const auto& entry:this->signals()) {
                const auto& s=entry.second;
                auto n=node(s,"signal",a); auto dd=s.getDescriptor();
                auto source=domainSource(entry.first);auto domain=s.getDomainSignal();
                std::string kind="unsupported";
                if(!source.empty())kind="time";
                else if(dd.assigned()&&numeric(dd.getSampleType())&&dd.getDimensions().getCount()==0&&domain.assigned())kind="scalar";
                else if(dd.assigned()&&numeric(dd.getSampleType())&&dd.getDimensions().getCount()==1&&dd.getDimensions()[0].getSize()<=16384)kind="vector";
                n["kind"]=str(kind,a);put(n,"readable",J(kind!="unsupported"),a);
                put(n,"domainSource",str(source,a),a);
                put(n,"domainId",str(domain.assigned()?txt(domain.getGlobalId()):"",a),a);
                put(n,"dimensions",J(dd.assigned()?static_cast<uint64_t>(dd.getDimensions().getCount()):0),a);
                put(n,"public",J(static_cast<bool>(s.getPublic())),a);
                if(dd.assigned()) {
                    put(n,"sampleType",J(static_cast<int>(dd.getSampleType())),a);
                    auto u=dd.getUnit(); put(n,"unit",str(u.assigned()?txt(u.getSymbol()):"",a),a);
                }
                signals.PushBack(n,a);
            }
            J blocks(rapidjson::kArrayType);
            for(const auto& b:instance.getFunctionBlocks()) {
                auto n=node(b,"block",a); J ports(rapidjson::kArrayType);
                for(const auto& p:b.getInputPorts()) {
                    auto q=node(p,"port",a); auto s=p.getSignal(); put(q,"signal",str(s.assigned()?txt(s.getGlobalId()):"",a),a); ports.PushBack(q,a);
                }
                J outputs(rapidjson::kArrayType);for(const auto& signal:b.getSignals())outputs.PushBack(str(txt(signal.getGlobalId()),a),a);
                put(n,"outputs",std::move(outputs),a);put(n,"ports",std::move(ports),a); blocks.PushBack(n,a); nodes.PushBack(node(b,"block",a),a);
            }
            J types(rapidjson::kArrayType);
            for(const auto& key:instance.getAvailableFunctionBlockTypes().getKeyList()) {
                auto t=instance.getAvailableFunctionBlockTypes().get(key); J n(rapidjson::kObjectType);
                put(n,"id",str(txt(key),a),a); put(n,"name",str(txt(t.getName()),a),a); types.PushBack(n,a);
            }
            put(out,"nodes",std::move(nodes),a); put(out,"signals",std::move(signals),a);
            put(out,"blocks",std::move(blocks),a); put(out,"blockTypes",std::move(types),a);
        } else if(op=="scan") {
            J devices(rapidjson::kArrayType);
            for(const auto& d:instance.getAvailableDevices()) {
                J n(rapidjson::kObjectType); put(n,"name",str(txt(d.getName()),a),a);
                put(n,"connection",str(txt(d.getConnectionString()),a),a); put(n,"serial",str(txt(d.getSerialNumber()),a),a);
                devices.PushBack(n,a);
            } put(out,"devices",std::move(devices),a);
        } else if(op=="connect") {
            auto config=instance.createDefaultAddDeviceConfig();
            if(req.HasMember("username")) {
                PropertyObjectPtr general=config.getPropertyValue("General");
                general.setPropertyValue("Username",field(req,"username"));
                general.setPropertyValue("Password",field(req,"password"));
            }
            auto d=instance.addDevice(field(req,"connection"),config); put(out,"id",str(txt(d.getGlobalId()),a),a);
        } else if(op=="disconnect") {
            auto d=component(field(req,"id")).asPtr<IDevice>();
            auto id=txt(d.getGlobalId());
            for(auto i=readers.begin();i!=readers.end();) { if(i->first.compare(0,id.size(),id)==0) i=readers.erase(i); else ++i; }
            instance.removeDevice(d);
        } else if(op=="properties") {
            auto obj=component(field(req,"id")).asPtr<IPropertyObject>(); J props(rapidjson::kArrayType);
            for(const auto& p:obj.getVisibleProperties()) {
                J n(rapidjson::kObjectType); put(n,"name",str(txt(p.getName()),a),a); put(n,"type",J(static_cast<int>(p.getValueType())),a);
                put(n,"readOnly",J(static_cast<bool>(p.getReadOnly())),a); put(n,"description",str(txt(p.getDescription()),a),a);
                try { put(n,"value",valueJson(obj.getPropertyValue(p.getName()),a),a); } catch(const std::exception& e) { put(n,"error",str(e.what(),a),a); }
                auto opts=p.getSelectionValues(); if(opts.assigned()) put(n,"selection",valueJson(opts,a),a);
                auto lo=p.getMinValue(); if(lo.assigned()) put(n,"min",valueJson(lo,a),a);
                auto hi=p.getMaxValue(); if(hi.assigned()) put(n,"max",valueJson(hi,a),a);
                props.PushBack(n,a);
            } put(out,"properties",std::move(props),a);
        } else if(op=="set") {
            auto obj=component(field(req,"id")).asPtr<IPropertyObject>(); auto name=field(req,"name"); auto p=obj.getProperty(name);
            if(p.getReadOnly()) throw std::runtime_error("Property is read-only");
            if(!req.HasMember("value")) throw std::runtime_error("Missing property value");
            const auto& v=req["value"]; BaseObjectPtr value;
            switch(p.getValueType()) {
                case ctBool: if(!v.IsBool()) throw std::runtime_error("Expected boolean"); value=Boolean(v.GetBool()); break;
                case ctInt: if(!v.IsInt64()) throw std::runtime_error("Expected integer"); value=Integer(v.GetInt64()); break;
                case ctFloat: if(!v.IsNumber()) throw std::runtime_error("Expected number"); value=Float(v.GetDouble()); break;
                case ctString: if(!v.IsString()) throw std::runtime_error("Expected string"); value=String(v.GetString()); break;
                default: throw std::runtime_error("This property type is inspection-only");
            } obj.setPropertyValue(name,value);
            put(out,"value",valueJson(obj.getPropertyValue(name),a),a);
        } else if(op=="subscribe") {
            if(!req.HasMember("signals") || !req["signals"].IsArray()) throw std::runtime_error("Expected signal list");
            if(req["signals"].Size()>16) throw std::runtime_error("Select at most 16 signals");
            std::map<std::string,Subscription> next;
            for(const auto& v:req["signals"].GetArray()) {
                if(!v.IsString()) throw std::runtime_error("Invalid signal id");std::string id=v.GetString();
                auto all=signals();auto found=all.find(id);if(found==all.end())throw std::runtime_error("Signal not found: "+id);
                auto s=found->second;auto dd=s.getDescriptor();Subscription sub;sub.source=id;
                auto source=domainSource(id);
                if(!source.empty()){sub.domain=true;sub.source=source;s=all.at(source);dd=s.getDescriptor();}
                if(!dd.assigned()||!numeric(dd.getSampleType()))throw std::runtime_error("Signal is not a supported numeric type: "+id);
                if(dd.getDimensions().getCount()==1&&!sub.domain)sub.packets=PacketReader(s);
                else if(dd.getDimensions().getCount()==0)sub.stream=StreamReaderBuilder().setSignal(s).setValueReadType(SampleType::Float64).setDomainReadType(SampleType::Int64).setSkipEvents(true).build();
                else throw std::runtime_error("Only scalar, TIME and one-dimensional numeric signals are supported: "+id);
                next.emplace(id,std::move(sub));
            } readers.swap(next);
        } else if(op=="samples") {
            J batches(rapidjson::kArrayType);
            for(auto& item:readers) {
                J b(rapidjson::kObjectType); put(b,"id",str(item.first,a),a);
                try {
                    if(item.second.packets.assigned()) {
                        put(b,"kind",str("vector",a),a);put(b,"frames",vectorSamples(item.second,a),a);
                        put(b,"pending",J(static_cast<uint64_t>(item.second.packets.getAvailableCount())),a);
                        batches.PushBack(b,a);continue;
                    }
                    auto signal=component(item.second.source).asPtr<ISignal>();auto ds=signal.getDomainSignal();
                    auto domainDescriptor=ds.assigned()?ds.getDescriptor():DataDescriptorPtr();
                    double scale=1;
                    if(domainDescriptor.assigned()&&domainDescriptor.getTickResolution().assigned()){auto r=domainDescriptor.getTickResolution();scale=static_cast<double>(r.getNumerator())/r.getDenominator();}
                    put(b,"kind",str(item.second.domain?"time":"scalar",a),a);
                    std::vector<double> values(16384); std::vector<Int> domain(16384); SizeT count=values.size();
                    auto status=item.second.stream.readWithDomain(values.data(),domain.data(),&count,0);
                    if(status.assigned() && !status.getValid()) throw std::runtime_error("Signal descriptor changed or reader became invalid; restart acquisition");
                    J ys(rapidjson::kArrayType),xs(rapidjson::kArrayType);
                    for(SizeT i=0;i<count;++i) { if(item.second.domain)values[i]=static_cast<double>(domain[i])*scale; ys.PushBack(std::isfinite(values[i])?J(values[i]):J(),a); xs.PushBack(str(std::to_string(domain[i]),a),a); }
                    put(b,"values",std::move(ys),a); put(b,"ticks",std::move(xs),a);
                    domainMetadata(b,domainDescriptor,a);
                    put(b,"pending",J(static_cast<uint64_t>(item.second.stream.getAvailableCount())),a);
                } catch(const std::exception& e) { put(b,"error",str(e.what(),a),a); }
                batches.PushBack(b,a);
            } put(out,"batches",std::move(batches),a);
        } else if(op=="block_add") {
            auto b=instance.addFunctionBlock(field(req,"type")); put(out,"id",str(txt(b.getGlobalId()),a),a);
        } else if(op=="block_remove") {
            readers.clear(); instance.removeFunctionBlock(component(field(req,"id")).asPtr<IFunctionBlock>());
        } else if(op=="port_connect") {
            component(field(req,"port")).asPtr<IInputPort>().connect(component(field(req,"signal")).asPtr<ISignal>());
        } else if(op=="port_disconnect") {
            component(field(req,"port")).asPtr<IInputPort>().disconnect();
        } else if(op=="config_save") {
            put(out,"configuration",str(txt(instance.saveConfiguration()),a),a);
        } else if(op=="config_load") {
            readers.clear(); instance.loadConfiguration(field(req,"configuration"));
        } else if(op=="stop") { readers.clear(); }
        else throw std::runtime_error("Unknown operation: "+op);
        return out;
    }
};
int main(int argc,char** argv) {
    try {
        Workstation app(argc>1?argv[1]:".");
        std::string line;
        while(std::getline(std::cin,line)) {
            rapidjson::Document doc; doc.Parse(line.c_str()); auto& a=doc.GetAllocator(); J reply(rapidjson::kObjectType);
            try {
                if(doc.HasParseError() || !doc.IsObject()) throw std::runtime_error("Invalid JSON request");
                auto result=app.run(doc,a); put(reply,"ok",J(true),a); put(reply,"result",std::move(result),a);
            } catch(const std::exception& e) { put(reply,"ok",J(false),a); put(reply,"error",str(e.what(),a),a); }
            rapidjson::StringBuffer buffer; rapidjson::Writer<rapidjson::StringBuffer> writer(buffer); reply.Accept(writer);
            std::cout << buffer.GetString() << std::endl;
        }
    } catch(const std::exception& e) { std::cerr << e.what() << std::endl; return 1; }
}
